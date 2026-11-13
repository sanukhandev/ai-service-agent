/** Disposable P4 queue/consent integration smoke; no n8n or Salesforce call. */
import assert from "node:assert/strict";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { workerTicketScope } from "../repositories/types.js";
import { LeadOperations, LEAD_CONSENT_TEXT } from "./lead-operations.js";

async function main():Promise<void> {
  if(process.env.P4_OFFLINE_SMOKE!=="1") throw new Error("P4 offline smoke only");
  const ticketId=process.env.P3_TEST_TICKET;
  if(!ticketId) throw new Error("P3_TEST_TICKET missing");
  // Enable ONLY this disposable Node process. The HTTP API's outbox worker
  // remains disabled in CI, so no external provider call is made.
  process.env.ANCFZ_LEAD_DISPATCH_ENABLED="true";
  process.env.ANCFZ_N8N_WEBHOOK_SECRET="ci-private-disposable-"+("a".repeat(40));
  const db=new PersistenceDatabase(undefined);
  try {
    await db.assertSafeRuntimeRole();
    const agent=await new AgentRepository(db).resolvePublicKey("ancfz");
    assert.ok(agent);
    const scope=workerTicketScope(agent.id,ticketId);
    const repo=new LeadOperations(db);
    const lead={
      requestId:"44444444-4444-4444-8444-444444444444",
      name:"Disposable Test",company:"ACME POC",phone:"+971 555555555",
      email:"demo@example.invalid",description:"Disposable integration scenario",
      consent:true,consentText:LEAD_CONSENT_TEXT,
    };
    await assert.rejects(()=>repo.submit(scope,ticketId,{...lead,consent:false}),
      (error:unknown)=>error instanceof PersistenceError && error.code==="INVALID_INPUT");
    const created=await repo.submit(scope,ticketId,lead);
    assert.equal(created.duplicated,false);
    assert.equal(created.operation.state,"queued");
    const retry=await repo.submit(scope,ticketId,{...lead,requestId:"55555555-5555-4555-8555-555555555555"});
    assert.equal(retry.duplicated,true);
    assert.equal(retry.operation.id,created.operation.id);
    await assert.rejects(()=>repo.submit(scope,ticketId,{...lead,company:"Changed"}),
      (error:unknown)=>error instanceof PersistenceError && error.code==="CONFLICT");
    const list=await repo.list(scope,ticketId);
    assert.equal(list.length,1);
    assert.equal(list[0]?.state,"queued");
    const outbox=await db.withAgent(agent.id,async client=>{
      const r=await client.query<{count:string;status:string}>(
        "SELECT count(*)::text AS count,max(status) AS status FROM event_outbox WHERE agent_id=$1 AND ticket_id=$2 AND event_type='ancfz_salesforce_lead'",
        [agent.id,ticketId],
      );return r.rows[0];
    });
    assert.equal(outbox?.count,"1");
    assert.equal(outbox?.status,"pending");
    console.log("P4 offline lead queue PASS: consent, idempotency, one outbox entry, RLS runtime, zero provider calls");
  }finally{await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
