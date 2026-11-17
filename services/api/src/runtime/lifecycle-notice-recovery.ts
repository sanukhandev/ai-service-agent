/**
 * Reconcile optional chat notices after a successful provider-state commit.
 * PostgreSQL remains authoritative. Recovery only READS verified state and
 * writes a deterministic assistant message; it never sends provider POSTs.
 */
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { lifecycleNoticeId, TicketMessageRepository } from "../repositories/messages.js";
import { authorizedTicket, workerTicketScope } from "../repositories/types.js";
import { leadDispatchEnabled } from "./lead-operations.js";
import { paymentEnabled } from "./payment-evidence.js";

const LEAD_TEXT =
  "Your ANCFZ Salesforce lead has been created and verified. Its reference is available in your ticket.";
const OTP_TEXT =
  "Your synthetic test OTP has been verified. Your sandbox order is queued; payment has not yet been confirmed.";
const PAYMENT_TEXT =
  "Your sandbox payment has been independently verified as COMPLETE. I am preparing your TEST invoice now.";

type Candidate = { id:string; ticket_id:string };
type Stage = "lead.verified" | "otp.verified" | "payment.verified";

/** Log safe diagnostic codes, not SQL text, provider payloads or customer data. */
function recoveryErrorCodes(error:unknown):Record<string,unknown> {
  const cause=error instanceof PersistenceError?error.cause:error;
  const sqlState=(cause as {code?:unknown}|null)?.code;
  return {
    errorCode:error instanceof Error?error.name:"UnknownError",
    ...(error instanceof PersistenceError?{persistenceCode:error.code}:{}),
    ...(typeof sqlState==="string"?{sqlState}:{}),
  };
}

export class LifecycleNoticeRecovery {
  private timer:ReturnType<typeof setInterval>|undefined;
  private stopped=false;
  private busy=false;
  private readonly messages:TicketMessageRepository;

  constructor(private readonly db:PersistenceDatabase,
    private readonly log:(data:Record<string,unknown>,message:string)=>void){
    this.messages=new TicketMessageRepository(db);
  }

  start():void {
    if(!leadDispatchEnabled() && !paymentEnabled()) return;
    this.timer=setInterval(()=>{void this.tick();},30000);
    this.timer.unref();
    void this.tick();
  }
  stop():void {
    this.stopped=true;
    if(this.timer)clearInterval(this.timer);
  }

  private async agentId():Promise<string|null> {
    const found=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active' LIMIT 1");
    return found.rows[0]?.id??null;
  }

  private async candidates(agentId:string,stage:Stage,copy:string):Promise<Candidate[]> {
    return this.db.withAgent(agentId, async client=>{
      // The text lookup is a bounded POC reconciliation fallback. The actual
      // insertion is keyed by deterministic request_id, so concurrent workers
      // cannot create two notices for the same milestone.
      const lead=stage==="lead.verified";
      const table=lead?"ticket_operations op":"ticket_payment_attempts op";
      const condition=lead
        ? "op.operation_key='ancfz_salesforce_lead' AND op.state='verified_completed'"
        : stage==="payment.verified"
          ? "op.state='verified_test_payment'"
          : "op.state IN ('queued','creating','checkout_available','order_created_checkout_unavailable','payment_pending') AND op.created_at>now()-interval '1 hour'";
      const key=stage==="otp.verified"?"op.otp_id":"op.id";
      // ticket_operations has consented_at, not created_at (migration 007).
      // Payment attempts use created_at (migration 009).
      const orderBy=lead?"op.consented_at":"op.created_at";
      const result=await client.query<Candidate>(
        `SELECT ${key} AS id,op.ticket_id FROM ${table}
          JOIN tickets t ON t.agent_id=op.agent_id AND t.id=op.ticket_id
          WHERE op.agent_id=$1 AND t.status<>'closed'
            AND ${condition}
            AND NOT EXISTS(
              SELECT 1 FROM ticket_messages m WHERE m.agent_id=op.agent_id
                AND m.ticket_id=op.ticket_id AND m.role='assistant' AND m.content=$2
            )
          ORDER BY ${orderBy}, op.id LIMIT 12`,
        [agentId,copy],
      );
      return result.rows;
    });
  }

  private async recover(agentId:string,stage:Stage,copy:string):Promise<void> {
    const rows=await this.candidates(agentId,stage,copy);
    for(const row of rows){
      // Revalidate inside the same ticket-row-locked transaction as the notice.
      // In particular, a refund must never be followed by a late 'paid' notice.
      try {
        const written=await this.db.withAgent(agentId,async client=>{
          const scope=workerTicketScope(agentId,row.ticket_id);
          const ticket=await authorizedTicket(client,scope,row.ticket_id,true);
          if(ticket.status==="closed")return false;
          let valid=false;
          if(stage==="lead.verified") {
            const found=await client.query<{id:string}>(
              "SELECT id FROM ticket_operations WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND operation_key='ancfz_salesforce_lead' AND state='verified_completed'",
              [agentId,row.ticket_id,row.id],
            );
            valid=Boolean(found.rows[0]);
          } else {
            const found=await client.query<{id:string}>(
              `SELECT id FROM ticket_payment_attempts WHERE agent_id=$1 AND ticket_id=$2
                 AND ${stage==="otp.verified"?"otp_id":"id"}=$3 AND state ${stage==="payment.verified"
                   ?"='verified_test_payment'"
                   :"IN ('queued','creating','checkout_available','order_created_checkout_unavailable','payment_pending')"}`,
              [agentId,row.ticket_id,row.id],
            );
            valid=Boolean(found.rows[0]);
          }
          if(!valid)return false;
          return this.messages.tryAssistantLifecycleNoticeTx(
            client,scope,row.ticket_id,lifecycleNoticeId(stage,row.id),copy);
        });
        if(written)this.log({stage,ticketId:row.ticket_id},"Recovered durable workflow chat notification");
      }catch(error){
        this.log({stage,...recoveryErrorCodes(error)},"Workflow chat recovery postponed");
      }
    }
  }

  private async tick():Promise<void> {
    if(this.busy||this.stopped)return;
    this.busy=true;
    try {
      const agentId=await this.agentId();
      if(!agentId)return;
      if(leadDispatchEnabled())await this.recover(agentId,"lead.verified",LEAD_TEXT);
      if(paymentEnabled()){
        await this.recover(agentId,"otp.verified",OTP_TEXT);
        await this.recover(agentId,"payment.verified",PAYMENT_TEXT);
      }
    } catch(error){
      this.log(recoveryErrorCodes(error),"Workflow notice reconciliation failed");
    } finally {this.busy=false;}
  }
}
