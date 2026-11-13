/** Disposable database integration: no n8n requests; Salesforce ID is synthetic. */
import assert from "node:assert/strict";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { workerTicketScope } from "../repositories/types.js";
import { QuotationOperations, QUOTATION_ACKNOWLEDGMENT } from "./quotation-operations.js";

async function run():Promise<void>{
  if(process.env.P4_QUOTATION_OFFLINE_SMOKE!=="1")throw new Error("CI-only quotation smoke");
  const ticketId=process.env.P3_TEST_TICKET;
  if(!ticketId)throw new Error("Missing P3_TEST_TICKET");
  process.env.ANCFZ_QUOTE_DISPATCH_ENABLED="true";
  process.env.ANCFZ_N8N_WEBHOOK_SECRET="ci-only-not-a-real-secret-"+("z".repeat(32));
  const db=new PersistenceDatabase(undefined);
  try{
    await db.assertSafeRuntimeRole();
    const agent=await new AgentRepository(db).resolvePublicKey("ancfz");
    assert.ok(agent);
    const scope=workerTicketScope(agent.id,ticketId);
    const quotes=new QuotationOperations(db);
    const notYet=await quotes.options(scope,ticketId);
    assert.equal(notYet.leadVerified,false);
    const request={
      requestId:"22222222-2222-4222-8222-222222222222",
      offeringKey:"company_setup_consultation",
      customerName:"Disposable POC",
      acknowledged:true,acknowledgmentText:QUOTATION_ACKNOWLEDGMENT,
    };
    await assert.rejects(()=>quotes.submit(scope,ticketId,request),
      (err:unknown)=>err instanceof PersistenceError&&err.code==="CONFLICT");
    // The disposable CI ticket had a fake n8n lead request created by lead-smoke.
    // This synthetic provider result is NEVER used by production.
    await db.withAgent(agent.id,async client=>{
      await client.query(
        "UPDATE ticket_operations SET state='verified_completed',provider_reference=$3,provider_status='ci_synthetic' WHERE agent_id=$1 AND ticket_id=$2 AND operation_key='ancfz_salesforce_lead' AND state='queued'",
        [agent.id,ticketId,"00Q"+("a".repeat(15))],
      );
      await client.query(
        "UPDATE event_outbox SET status='completed' WHERE agent_id=$1 AND ticket_id=$2 AND event_type='ancfz_salesforce_lead' AND status='pending'",
        [agent.id,ticketId],
      );
    });
    const options=await quotes.options(scope,ticketId);
    assert.equal(options.leadVerified,true);
    assert(options.options.some(o=>o.offeringKey==="company_setup_consultation"&&o.amount==="16200.00"));
    await assert.rejects(()=>quotes.submit(scope,ticketId,{...request,offeringKey:"not_published"}),
      (err:unknown)=>err instanceof PersistenceError&&err.code==="CONFLICT");
    const made=await quotes.submit(scope,ticketId,request);
    assert.equal(made.duplicated,false);
    assert.equal(made.quotation.state,"queued");
    assert.equal(made.quotation.amount,"16200.00");
    assert.equal(made.quotation.currency,"AED");
    assert.equal(made.quotation.pdfAvailable,false);
    const retried=await quotes.submit(scope,ticketId,{...request,requestId:"55555555-5555-4555-8555-555555555555"});
    assert.equal(retried.duplicated,true);
    assert.equal(retried.quotation.id,made.quotation.id);
    await assert.rejects(()=>quotes.submit(scope,ticketId,{...request,customerName:"Other"}),
      (err:unknown)=>err instanceof PersistenceError&&err.code==="CONFLICT");
    const found=await quotes.get(scope,ticketId);
    assert.equal(found?.id,made.quotation.id);
    await assert.rejects(()=>quotes.pdf(scope,ticketId,made.quotation.id),
      (err:unknown)=>err instanceof PersistenceError&&err.code==="NOT_FOUND");
    const counts=await db.withAgent(agent.id,async client=>{
      const r=await client.query<{count:string}>(
        "SELECT count(*)::text AS count FROM event_outbox WHERE agent_id=$1 AND ticket_id=$2 AND event_type='ancfz_render_quote'",
        [agent.id,ticketId],
      );
      return r.rows[0]?.count;
    });
    assert.equal(counts,"1");
    console.log("P4 quotation DB smoke PASS: verified Lead gate, pinned effective price, snapshot, consent, one outbox, no external calls");
  }finally{await db.close();}
}
run().catch(err=>{console.error(err);process.exitCode=1;});
