import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { ModelTurnRequest, ModelTurnResult } from "@ai-service-agent/contracts/gemini-v1";
import { PersistenceDatabase } from "../database/pool.js";
import { GuestSessionRepository } from "../repositories/tickets.js";
import { GeminiSessionRepository } from "../repositories/gemini.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { GeminiTurnWorker } from "./gemini-worker.js";
import { TurnQueue } from "./turn-queue.js";

test("Gemini worker records supported reply and audit atomically (real disposable PostgreSQL)",async()=>{
  assert.equal(process.env.P2_TEST_DB_ONLY,"1","Refuse test outside disposable database");
  const db=new PersistenceDatabase(undefined);
  const queue=new TurnQueue(db);
  const modelRequests:ModelTurnRequest[]=[];
  const fakeFactory=async()=>({
    async runTurn(request:ModelTurnRequest):Promise<ModelTurnResult>{
      modelRequests.push(request);
      return {kind:"candidate",candidate:{
        provider:"gemini",modelId:request.agent.modelId,text:"Hello!",
        sourceAnnotations:[],functionCalls:[],continuation:null,
        usage:{inputTokens:1,outputTokens:2},finishReason:"STOP",
      }};
    },
    async continueWithFunctionOutputs():Promise<ModelTurnResult>{
      throw new Error("Unexpected tool continuation");
    },
  });
  const worker=new GeminiTurnWorker(db,queue,()=>{},"test-only-no-google-network",
    randomBytes(32).toString("hex"),fakeFactory);
  try {
    await db.assertSafeRuntimeRole();
    const rows=await db.pool.query<{id:string}>("SELECT id FROM agents WHERE agent_key='ancfz'");
    const agentId=rows.rows[0]?.id;
    assert.ok(agentId);
    const guest=await new GuestSessionRepository(db).create(agentId);
    const scope={agentId,owner:{kind:"guest" as const,token:guest.token}};
    const session=await new GeminiSessionRepository(db).startNew(scope,"Gemini worker integration");
    const requestId=randomUUID();
    const admitted=await new GeminiSessionRepository(db).admitCustomerMessage(scope,session.sessionId,requestId,"Hi");
    assert.equal(admitted.kind,"accepted");
    assert.ok(admitted.message);
    await queue.enqueue(scope,session.ticketId,admitted.message.id,requestId);
    await worker.start();
    let assistant=null;
    for(let i=0;i<100;i++){
      const history=await new TicketMessageRepository(db).listTicketMessages(scope,session.ticketId,"0",20);
      assistant=history.find(x=>x.role==="assistant")??null;
      if(assistant)break;
      await new Promise(resolve=>setTimeout(resolve,60));
    }
    assert.ok(assistant,"Gemini assistant reply never committed");
    assert.equal(assistant.text,"Hello!");
    assert.equal(modelRequests.length,1);
    assert.equal(modelRequests[0].session.sessionId,session.sessionId);
    assert.equal(modelRequests[0].agent.provider,"gemini");
    const saved=await db.withAgent(agentId,async client=>{
      const turns=await client.query<{state:string;provider_response_id:string|null}>(
        "SELECT state,provider_response_id FROM ticket_turns WHERE agent_id=$1 AND ticket_id=$2 AND request_id=$3",
        [agentId,session.ticketId,requestId]);
      const audits=await client.query<{category:string;grounding_status:string;assistant_message_id:string}>(
        "SELECT category,grounding_status,assistant_message_id FROM gemini_response_qualifications WHERE agent_id=$1 AND session_id=$2",
        [agentId,session.sessionId]);
      const events=await client.query<{event_type:string}>(
        "SELECT event_type FROM ticket_events WHERE agent_id=$1 AND ticket_id=$2 ORDER BY created_at",
        [agentId,session.ticketId]);
      return {turns:turns.rows,audits:audits.rows,events:events.rows.map(x=>x.event_type)};
    });
    assert.equal(saved.turns[0]?.state,"completed");
    assert.equal(saved.turns[0]?.provider_response_id,null,"No invented Foundry response cursor");
    assert.equal(saved.audits[0]?.category,"social");
    assert.equal(saved.audits[0]?.grounding_status,"supported");
    assert.equal(saved.audits[0]?.assistant_message_id,assistant.id);
    assert.ok(saved.events.includes("assistant.message"),"Assistant event must be persisted before SSE");
  } finally {worker.stop();await db.close();}
});
