/**
 * ANCFZ P4 outbox dispatcher. Only Node initiates the private n8n workflow.
 * An uncertain provider call is NEVER automatically retried: Apex REST
 * has no demonstrated idempotency contract and may have created a Lead.
 */
import { PersistenceDatabase } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { leadDispatchEnabled, verifiedLeadResult } from "./lead-operations.js";

interface Claim {
  agentId:string; ticketId:string; operationId:string;
  outboxId:string; payload:Record<string,unknown>;
}
const endpoint="http://n8n:5678/webhook/ancfz/salesforce-lead";

export class N8nLeadWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private busy=false;
  private stopped=false;
  private lastSweep=0;

  constructor(
    private readonly db:PersistenceDatabase,
    private readonly log:(info:Record<string,unknown>,message:string)=>void,
  ) {}

  start():void {
    if (!leadDispatchEnabled()) {
      this.log({enabled:false},"ANCFZ lead dispatcher disabled; no n8n calls will be made");
      return;
    }
    this.timer=setInterval(()=>{void this.tick();},2000);
    this.timer.unref();
    void this.tick();
  }

  stop():void {
    this.stopped=true;
    if(this.timer) clearInterval(this.timer);
  }

  private async agentId():Promise<string|null> {
    const result=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active' LIMIT 1",
    );
    return result.rows[0]?.id??null;
  }

  private async quarantineExpired(agentId:string):Promise<void> {
    await this.db.withAgent(agentId,async client=>{
      const records=await client.query<{id:string;outbox_id:string;ticket_id:string}>(
        "SELECT op.id,op.outbox_id,op.ticket_id FROM ticket_operations op JOIN event_outbox e ON e.agent_id=op.agent_id AND e.id=op.outbox_id WHERE op.agent_id=$1 AND op.state='running' AND e.status='leased' AND e.lease_until<now() FOR UPDATE OF op SKIP LOCKED LIMIT 20",
        [agentId],
      );
      for(const op of records.rows) {
        await client.query(
          "UPDATE ticket_operations SET state='unknown_outcome',provider_status='lease_expired',updated_at=now() WHERE agent_id=$1 AND id=$2 AND state='running'",
          [agentId,op.id],
        );
        await client.query(
          "UPDATE event_outbox SET status='dead',lease_until=NULL WHERE agent_id=$1 AND id=$2 AND status='leased'",
          [agentId,op.outbox_id],
        );
        await appendEventTx(client,agentId,op.ticket_id,"operation.failed",{
          operationId:op.id,reason:"Provider outcome unknown; manual reconciliation required",
        });
      }
    });
  }

  private async claim(agentId:string):Promise<Claim|null> {
    return this.db.withAgent(agentId,async client=>{
      const chosen=await client.query<{
        id:string;ticket_id:string;operation_id:string;payload:Record<string,unknown>;
      }>(
        [
          "SELECT e.id,e.ticket_id,op.id AS operation_id,e.payload",
          "FROM event_outbox e JOIN ticket_operations op",
          "ON op.agent_id=e.agent_id AND op.ticket_id=e.ticket_id AND op.outbox_id=e.id",
          "WHERE e.agent_id=$1 AND e.event_type='ancfz_salesforce_lead'",
          "AND e.status='pending' AND e.available_at<=now() AND op.state='queued'",
          "ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1",
        ].join(" "),[agentId],
      );
      const op=chosen.rows[0];
      if(!op) return null;
      await client.query(
        "UPDATE event_outbox SET status='leased',attempts=attempts+1,lease_until=now()+interval '90 seconds' WHERE agent_id=$1 AND id=$2 AND status='pending'",
        [agentId,op.id],
      );
      await client.query(
        "UPDATE ticket_operations SET state='running',updated_at=now() WHERE agent_id=$1 AND id=$2 AND state='queued'",
        [agentId,op.operation_id],
      );
      await appendEventTx(client,agentId,op.ticket_id,"operation.running",{
        operationId:op.operation_id,operationType:"ancfz_salesforce_lead",
      });
      return {agentId,ticketId:op.ticket_id,operationId:op.operation_id,outboxId:op.id,payload:op.payload};
    });
  }

  private async deliver(op:Claim):Promise<{leadId:string|null;status:string}> {
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(!secret || secret.length<32) return {leadId:null,status:"not_configured"};
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),30000);
    try {
      const response=await fetch(endpoint,{
        method:"POST",
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify(op.payload),
        signal:controller.signal,
        redirect:"error",
      });
      if(!response.ok) return {leadId:null,status:"n8n_http_"+response.status};
      const text=await response.text();
      if(text.length>32768) return {leadId:null,status:"n8n_result_too_large"};
      let body:unknown;
      try {body=JSON.parse(text);} catch{return {leadId:null,status:"n8n_invalid_json"};}
      const leadId=verifiedLeadResult(body,op.ticketId);
      return {leadId,status:leadId?"verified_completed":"unverified_provider_response"};
    } catch {
      return {leadId:null,status:"dispatch_unknown"};
    } finally {
      clearTimeout(timeout);
    }
  }

  private async finalize(op:Claim,result:{leadId:string|null;status:string}):Promise<void> {
    await this.db.withAgent(op.agentId,async client=>{
      const current=await client.query<{state:string}>(
        "SELECT state FROM ticket_operations WHERE agent_id=$1 AND id=$2 FOR UPDATE",
        [op.agentId,op.operationId],
      );
      // A lease sweep may have quarantined an expired operation. Never overwrite.
      if(current.rows[0]?.state!=="running") return;
      const success=Boolean(result.leadId);
      await client.query(
        "UPDATE ticket_operations SET state=$3,provider_reference=$4,provider_status=$5,updated_at=now() WHERE agent_id=$1 AND id=$2",
        [op.agentId,op.operationId,success?"verified_completed":"unknown_outcome",result.leadId,result.status],
      );
      await client.query(
        "UPDATE event_outbox SET status=$3,lease_until=NULL WHERE agent_id=$1 AND id=$2",
        [op.agentId,op.outboxId,success?"completed":"dead"],
      );
      await appendEventTx(client,op.agentId,op.ticketId,
        success?"operation.completed":"operation.failed",
        success ? {
          operationId:op.operationId,operationType:"ancfz_salesforce_lead",
          providerReference:result.leadId,verified:true,
        } : {
          operationId:op.operationId,operationType:"ancfz_salesforce_lead",
          reason:"Provider outcome unverified; manual reconciliation required",
        },
      );
    });
  }

  private async tick():Promise<void> {
    if(this.stopped||this.busy||!leadDispatchEnabled())return;
    this.busy=true;
    try {
      const agentId=await this.agentId();
      if(!agentId)return;
      if(Date.now()-this.lastSweep>30000) {
        await this.quarantineExpired(agentId);
        this.lastSweep=Date.now();
      }
      const op=await this.claim(agentId);
      if(!op)return;
      const result=await this.deliver(op);
      await this.finalize(op,result);
      this.log({
        ticketId:op.ticketId,operationId:op.operationId,
        outcome:result.leadId?"verified_completed":"unknown_outcome",
        status:result.status,
      },"ANCFZ Salesforce lead workflow outcome recorded");
    } catch(error) {
      this.log({code:(error as Error).name},"ANCFZ n8n worker failed; leased operation requires reconciliation");
    } finally {this.busy=false;}
  }
}
