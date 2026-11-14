import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {PersistenceDatabase} from "../database/pool.js";
import {GuestSessionRepository} from "./tickets.js";
import {GeminiSessionRepository} from "./gemini.js";
import {ConversationContextRepository} from "./context.js";
import {TicketMessageRepository} from "./messages.js";
import {extractiveSummary,buildSessionContext} from "../runtime/conversation-continuity.js";

test("Gemini 56-message timeline uses latest messages, excludes future turns and preserves corrected facts (real disposable PostgreSQL)",async()=>{
  assert.equal(process.env.P2_TEST_DB_ONLY,"1","Refusing non-disposable database");
  const db=new PersistenceDatabase(undefined);
  try{
    await db.assertSafeRuntimeRole();
    const owner=await db.pool.query<{id:string}>("SELECT id FROM agents WHERE agent_key='ancfz'");
    const agentId=owner.rows[0]?.id;
    assert(agentId);
    const guest=await new GuestSessionRepository(db).create(agentId);
    const scope={agentId,owner:{kind:"guest" as const,token:guest.token}};
    const sessions=new GeminiSessionRepository(db);
    const context=new ConversationContextRepository(db);
    const session=await sessions.startNew(scope,"Bounded timeline integration");
    const admitted:{id:string;sequence:number}[]=[];
    await context.selectIntent(scope,session.ticketId,"company_formation");
    for(let i=1;i<=56;i++){
      const requestId=randomUUID();
      const message=await sessions.admitCustomerMessage(scope,session.sessionId,
        requestId,i===1?"I need two visas":i===56?"Correction: three visas, not two":"Test customer utterance "+i);
      assert.equal(message.kind,"accepted");
      assert(message.message);
      admitted.push({id:message.message.id,sequence:i});
      if(i===1||i===56){
        await context.recordCustomerFacts(scope,session.ticketId,message.message.id,[
          {key:"visa_count",value:i===1?2:3},
        ]);
      }
    }
    const latest=await sessions.forModelTurn(scope,session.ticketId,admitted[55].id);
    assert(latest?.active);
    assert.equal(latest.messages.length,17);
    assert.equal(latest.messages[0].text,"Test customer utterance 40");
    assert.equal(latest.messages.at(-1)?.text,"Correction: three visas, not two");
    assert.equal(latest.olderCustomerMessages.length,24);
    assert.equal(latest.olderCustomerMessages.at(-1)?.sequence,"39");
    const at30=await sessions.forModelTurn(scope,session.ticketId,admitted[29].id);
    assert(at30?.active);
    assert.equal(at30.messages.at(-1)?.text,"Test customer utterance 30");
    assert(!at30.messages.some(m=>m.text.includes("Correction: three")));
    const facts=await context.read(scope,session.ticketId);
    assert.equal(facts.activeIntent,"company_formation");
    assert.equal(facts.knownFacts["visa_count"],3);
    const digest=extractiveSummary(latest.olderCustomerMessages);
    assert(digest);
    await context.appendSummary(scope,session.ticketId,digest.text);
    const reloaded=await context.read(scope,session.ticketId);
    assert.equal(reloaded.summary?.text,digest.text);
    const snapshot=JSON.parse(buildSessionContext(reloaded,
      {intentKey:"company_formation",actions:[]},digest.text,[])) as {
        activeIntent:string;facts:Array<{key:string;value:number}>;
        historicalCustomerExcerpts:Array<{sequence:string;quote:string}>;
      };
    assert.equal(snapshot.activeIntent,"company_formation");
    assert.equal(snapshot.facts.find(f=>f.key==="visa_count")?.value,3);
    assert(snapshot.historicalCustomerExcerpts.length>0);
    const uiHistory=await sessions.recover(scope,session.sessionId,"0",100);
    assert.equal(uiHistory.messages.length,56);
    assert.equal(uiHistory.messages[0]?.text,"I need two visas");
    assert.equal(uiHistory.messages.at(-1)?.text,"Correction: three visas, not two");
    // A citation from an older assistant message must remain owner-accessible
    // after it disappears from the latest-200 UI snapshot.
    const messageRepo=new TicketMessageRepository(db);
    const sourceId="synthetic-source-"+randomUUID();
    await messageRepo.createAssistantMessage(scope,session.ticketId,randomUUID(),
      "Synthetic cited response",[{sourceId,title:"Synthetic approved-file fixture"}]);
    await db.withAgent(agentId,async client=>{
      const expanded=await client.query<{last_message_sequence:string}>(
        "UPDATE tickets SET last_message_sequence=last_message_sequence+205 WHERE agent_id=$1 AND id=$2 RETURNING last_message_sequence",
        [agentId,session.ticketId]);
      const last=Number(expanded.rows[0]?.last_message_sequence);
      assert(Number.isSafeInteger(last));
      await client.query(
        `INSERT INTO ticket_messages(agent_id,ticket_id,role,content,message_sequence)
         SELECT $1,$2,'customer','Archived synthetic turn '||seq,seq
         FROM generate_series($3::bigint,$4::bigint) AS seq`,
        [agentId,session.ticketId,last-204,last]);
    });
    const latestUi=await messageRepo.recentMessages(scope,session.ticketId,200);
    assert.equal(latestUi.length,200);
    assert(!latestUi.some(m=>m.sourceReferences.some(r=>r.sourceId===sourceId)));
    const located=await messageRepo.findSourceReference(scope,session.ticketId,sourceId);
    assert.equal(located?.title,"Synthetic approved-file fixture");
    const otherGuest=await new GuestSessionRepository(db).create(agentId);
    await assert.rejects(()=>messageRepo.findSourceReference({
      agentId,owner:{kind:"guest" as const,token:otherGuest.token},
    },session.ticketId,sourceId));

  }finally{await db.close();}
});
