import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PersistenceDatabase } from "../database/pool.js";
import { createApi } from "./app.js";
import { TurnQueue } from "./turn-queue.js";

/** Real PostgreSQL, Fastify inject; no Google credentials or outbound API calls. */
test("Gemini HTTP admission: 60-minute session and fresh-ticket isolation",async()=>{
  assert.equal(process.env.P2_TEST_DB_ONLY,"1","Disposable database only");
  const db=new PersistenceDatabase(undefined);
  const app=createApi(db,new TurnQueue(db));
  try{
    await db.assertSafeRuntimeRole();
    const create=await app.inject({method:"POST",url:"/api/v1/agents/ancfz/tickets"});
    assert.equal(create.statusCode,201,create.body);
    const ticket=create.json() as {id:string;sessionId:string;expiresAt:string;agentKey:string};
    assert.equal(ticket.agentKey,"ancfz");
    assert.ok(ticket.id && ticket.sessionId && ticket.expiresAt);
    const cookie=create.headers["set-cookie"]?.toString().split(";")[0];
    assert.ok(cookie?.startsWith("sa_guest="));
    const read=await app.inject({method:"GET",url:"/api/v1/tickets/"+ticket.id,headers:{cookie}});
    assert.equal(read.statusCode,200,read.body);
    assert.equal(read.json().ticket.sessionStatus,"active");
    const messageId=randomUUID();
    const send=await app.inject({method:"POST",url:"/api/v1/tickets/"+ticket.id+"/messages",
      headers:{cookie},payload:{requestId:messageId,text:"Hello Sara"}});
    assert.equal(send.statusCode,202,send.body);
    assert.equal(send.json().sessionId,ticket.sessionId);
    const duplicate=await app.inject({method:"POST",url:"/api/v1/tickets/"+ticket.id+"/messages",
      headers:{cookie},payload:{requestId:messageId,text:"Hello Sara"}});
    assert.equal(duplicate.statusCode,200,duplicate.body);
    assert.equal(duplicate.json().status,"duplicate");
    // Force the authoritative clock boundary; SSE and GET do not extend it.
    const agent=await db.pool.query<{id:string}>("SELECT id FROM agents WHERE agent_key='ancfz'");
    const agentId=agent.rows[0]?.id;
    assert.ok(agentId);
    await db.withAgent(agentId,async client=>{
      await client.query("UPDATE ai_conversation_sessions SET expires_at=clock_timestamp()-interval '1 second',last_accepted_customer_message_at=clock_timestamp()-interval '61 minutes' WHERE agent_id=$1 AND id=$2",[agentId,ticket.sessionId]);
    });
    const stale=await app.inject({method:"POST",url:"/api/v1/tickets/"+ticket.id+"/messages",
      headers:{cookie},payload:{requestId:randomUUID(),text:"I had two visas"}});
    assert.equal(stale.statusCode,409,stale.body);
    assert.equal(stale.json().code,"SESSION_EXPIRED");
    const next=await app.inject({method:"POST",url:"/api/v1/agents/ancfz/tickets",headers:{cookie}});
    assert.equal(next.statusCode,201,next.body);
    const fresh=next.json() as {id:string;sessionId:string};
    assert.notEqual(fresh.id,ticket.id);
    assert.notEqual(fresh.sessionId,ticket.sessionId);
    const blank=await app.inject({method:"GET",url:"/api/v1/tickets/"+fresh.id,headers:{cookie}});
    assert.equal(blank.statusCode,200,blank.body);
    assert.deepEqual(blank.json().messages,[],"No cross-session AI memory");
    const old=await app.inject({method:"GET",url:"/api/v1/tickets/"+ticket.id,headers:{cookie}});
    assert.equal(old.statusCode,200,"Historical ticket remains available");
    assert.equal(old.json().ticket.sessionStatus,"expired");
  }finally{await app.close();await db.close();}
});
