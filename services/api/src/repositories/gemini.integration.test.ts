// PostgreSQL integration: run against disposable Gemini Docker Postgres only.
// Requires npm build in services/api and P2_TEST_DB_ONLY=1 in test container.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PersistenceDatabase } from "../database/pool.js";
import { GuestSessionRepository } from "./tickets.js";
import { GeminiSessionRepository, GeminiBindingRepository } from "./gemini.js";
import { GeminiQualificationRepository } from "./gemini-qualification.js";

test("Gemini P2 authoritative sessions, boundaries and restart recovery", async () => {
  assert.equal(process.env.P2_TEST_DB_ONLY, "1", "Refuse to run outside disposable test database");
  const db=new PersistenceDatabase(undefined);
  await db.assertSafeRuntimeRole();
  const agents=await db.pool.query<{id:string}>("SELECT id FROM agents WHERE agent_key='ancfz'");
  assert.equal(agents.rowCount,1);
  const agentId=agents.rows[0].id;
  const guest=await new GuestSessionRepository(db).create(agentId);
  const scope={agentId,owner:{kind:"guest" as const,token:guest.token}};
  const sessions=new GeminiSessionRepository(db);
  const bindings=new GeminiBindingRepository(db);
  const audits=new GeminiQualificationRepository(db);
  try {
    const s1=await sessions.startNew(scope,"P2 integration test");
    assert.notEqual(s1.sessionId,s1.ticketId);
    assert.notEqual(s1.sessionId,guest.token);
    assert.equal(s1.status,"active");
    assert.equal(new Date(s1.expiresAt).getTime()-new Date(s1.lastAcceptedCustomerMessageAt).getTime(),3_600_000);
    const cfg=await bindings.forSession(scope,s1.sessionId);
    assert.equal(cfg.provider,"gemini");
    assert.equal(cfg.agentVersionId,s1.agentVersionId);
    assert.equal(cfg.knowledge,null,"No fabricated File Search binding");
    assert.equal(cfg.intentCatalogVersionId,s1.intentCatalogVersionId);
    assert.deepEqual(cfg.authorizedToolNames,[
      "find_intents","select_ticket_intent","get_intent_requirements",
      "record_ticket_facts","get_offerings",
    ]);

    const requestId=randomUUID();
    const accepted=await sessions.admitCustomerMessage(scope,s1.sessionId,requestId,"Hello Sara");
    assert.equal(accepted.kind,"accepted");
    const expiration=accepted.session.expiresAt;
    const again=await sessions.admitCustomerMessage(scope,s1.sessionId,requestId,"Hello Sara");
    assert.equal(again.kind,"duplicate");
    assert.equal(again.session.expiresAt,expiration);
    const hist=await sessions.recover(scope,s1.sessionId);
    assert.equal(hist.active,true);
    assert.equal(hist.messages.length,1);

    const q=await audits.record(scope,s1.sessionId,accepted.message!.id,{
      category:"social",status:"supported",verifierVersion:"p2-test-1",
      reasonCode:null,claims:[],
    });
    assert.equal(q.claimCount,0);
    await assert.rejects(
      audits.record(scope,s1.sessionId,accepted.message!.id,{
        category:"catalog_factual",status:"supported",verifierVersion:"p2-test-1",
        reasonCode:null,claims:[{
          claimId:"price",claimText:"Unapproved test price",supported:true,reason:null,
          evidence:[{authority:"approved_catalog",evidenceId:"offering/"+s1.offeringCatalogVersionId,
            documentVersionId:null,knowledgeVersionId:null}],
        }],
      }),
      /Persistence|constraint/i,
      "Unapproved test catalogs cannot authorize factual claims",
    );

    await sessions.advanceContinuation(scope,s1.sessionId,null,"opaque-cursor",null);
    const continued=await sessions.recover(scope,s1.sessionId);
    assert.equal(continued.session.providerContinuation?.opaqueRef,"opaque-cursor");

    async function backdate(sessionId:string,minutes:number) {
      await db.withAgent(agentId,async client=>{
        await client.query(
          "WITH t AS (SELECT clock_timestamp()-($3::int*interval '1 minute') AS at) UPDATE ai_conversation_sessions s SET last_accepted_customer_message_at=t.at,expires_at=t.at+interval '60 minutes' FROM t WHERE s.agent_id=$1 AND s.id=$2",
          [agentId,sessionId,minutes],
        );
      });
    }
    await backdate(s1.sessionId,59);
    const at59=await sessions.admitCustomerMessage(scope,s1.sessionId,randomUUID(),"Still here");
    assert.equal(at59.kind,"accepted","59-minute activity extends session");
    await backdate(s1.sessionId,60);
    const at60=await sessions.admitCustomerMessage(scope,s1.sessionId,randomUUID(),"Too late");
    assert.equal(at60.kind,"expired","At/after 60 minutes cannot revive session");
    assert.equal((await sessions.recover(scope,s1.sessionId)).messages.length,0);
    const oldTicket=await db.withAgent(agentId,client=>client.query(
      "SELECT id FROM tickets WHERE agent_id=$1 AND id=$2",[agentId,s1.ticketId],
    ));
    assert.equal(oldTicket.rowCount,1,"Historical ticket persists after AI expiry");

    const s2=await sessions.startNew(scope,"Fresh ticket after expiry");
    assert.notEqual(s2.sessionId,s1.sessionId);
    assert.notEqual(s2.ticketId,s1.ticketId);
    assert.equal((await sessions.recover(scope,s2.sessionId)).messages.length,0);
    assert.equal(s2.providerContinuation,null,"New session has no prior provider context");

    const s3=await sessions.startNew(scope,"Concurrent expiry boundary");
    await backdate(s3.sessionId,60);
    const atBoundary=await Promise.all([
      sessions.admitCustomerMessage(scope,s3.sessionId,randomUUID(),"first"),
      sessions.admitCustomerMessage(scope,s3.sessionId,randomUUID(),"second"),
    ]);
    assert.deepEqual(atBoundary.map(x=>x.kind),["expired","expired"]);
    const boundaryCount=await db.withAgent(agentId,c=>c.query<{n:string}>(
      "SELECT count(*)::text AS n FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2",
      [agentId,s3.ticketId],
    ));
    assert.equal(boundaryCount.rows[0].n,"0","No acceptance at 60-minute boundary");

    const s4=await sessions.startNew(scope,"Concurrent idempotency");
    const dedupeId=randomUUID();
    const concurrent=await Promise.all([
      sessions.admitCustomerMessage(scope,s4.sessionId,dedupeId,"once"),
      sessions.admitCustomerMessage(scope,s4.sessionId,dedupeId,"once"),
    ]);
    assert.deepEqual(new Set(concurrent.map(x=>x.kind)),new Set(["accepted","duplicate"]));
    await sessions.close(scope,s4.sessionId);
    assert.equal((await sessions.recover(scope,s4.sessionId)).active,false);

    // Simulates API process restart / complete Redis eviction. The second
    // independent PostgreSQL pool recovers committed messages and only this ticket.
    const persistent=await sessions.startNew(scope,"Recover after restart");
    await sessions.admitCustomerMessage(scope,persistent.sessionId,randomUUID(),"durable");
    const secondDb=new PersistenceDatabase(undefined);
    try {
      await secondDb.assertSafeRuntimeRole();
      const reloaded=await new GeminiSessionRepository(secondDb).recover(scope,persistent.sessionId);
      assert.equal(reloaded.active,true);
      assert.deepEqual(reloaded.messages.map(x=>x.text),["durable"]);
    } finally {await secondDb.close();}
  } finally {await db.close();}
});
