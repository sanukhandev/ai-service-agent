#!/usr/bin/env node
/** Synthetic, provider-free test for customer's affirmative checkout request
 * after Node's verified quotation prompt. No real payment or authorization. */
import assert from "node:assert/strict";
import {
  ConversationActionHandoff,isCheckoutContinuation,
} from "../services/api/dist/runtime/conversation-action-handoff.js";
import { workerTicketScope } from "../services/api/dist/repositories/types.js";

const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticketId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const messageId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const scope=workerTicketScope(agentId,ticketId);
const prompt="Your verified quotation PDF is available here in the conversation. "+
  "Would you like to continue with the sandbox documents and test checkout?";
assert.equal(isCheckoutContinuation("yes"),true);
assert.equal(isCheckoutContinuation("please proceed"),true);
assert.equal(isCheckoutContinuation("continue"),true);
assert.equal(isCheckoutContinuation("What's the cost of checkout?"),false);
assert.equal(isCheckoutContinuation("yes, but change the visa count"),false);

let previous="generate_quote",stage="quote_ready",lastRole="assistant",lastText=prompt;
let sequence=70;
const events=[];
const db={withAgent:async(id,fn)=>{
  assert.equal(id,agentId);
  return fn({query:async(sql,params=[])=>{
    if(sql.includes("SELECT * FROM tickets WHERE agent_id"))
      return {rows:[{id:ticketId}]};
    if(sql.includes("SELECT role,content FROM ticket_messages")){
      assert.deepEqual(params,[agentId,ticketId,messageId]);
      return {rows:lastText===null?[]:[{role:lastRole,content:lastText}]};
    }
    if(sql.includes("UPDATE tickets SET last_event_sequence")){
      sequence++;
      return {rows:[{last_event_sequence:String(sequence)}]};
    }
    if(sql.includes("INSERT INTO ticket_events")){
      events.push({eventType:params[3],payload:JSON.parse(params[4])});
      return {rows:[{id:messageId,ticket_id:ticketId,sequence:String(sequence),
        event_type:params[3],payload:JSON.parse(params[4]),created_at:new Date()}]};
    }
    throw Error("Unexpected mock SQL: "+sql.slice(0,120));
  }});
}};
const handoff=new ConversationActionHandoff(db);
handoff.current=async()=>previous;
handoff.status=async()=>stage?{stage,response:prompt,missingCount:0}:null;

let result=await handoff.observe(scope,ticketId,messageId,"yes");
assert.deepEqual(result,{action:"purchase_quotation",explicit:true});
assert.deepEqual(events,[{
  eventType:"customer.action.requested",
  payload:{sourceMessageId:messageId,actionKey:"purchase_quotation"},
}]);

// The previous visible assistant reply must be exactly the relevant prompt.
// A casual "yes" to some unrelated question cannot start checkout.
events.length=0;
lastText="Is this the contact email you want to use?";
result=await handoff.observe(scope,ticketId,messageId,"yes");
assert.deepEqual(result,{action:"generate_quote",explicit:false});
assert.equal(events.length,0);

// Outdated quoted state cannot cause a transition.
lastText=prompt;
stage="quote_processing";
result=await handoff.observe(scope,ticketId,messageId,"please proceed");
assert.deepEqual(result,{action:"generate_quote",explicit:false});
assert.equal(events.length,0);

// A non-assistant or missing latest reply is not sufficient context.
stage="quote_ready";lastRole="customer";
result=await handoff.observe(scope,ticketId,messageId,"continue");
assert.deepEqual(result,{action:"generate_quote",explicit:false});
lastRole="assistant";lastText=null;
result=await handoff.observe(scope,ticketId,messageId,"yes");
assert.deepEqual(result,{action:"generate_quote",explicit:false});

// Explicit customer requests remain independently supported.
lastText=null;
result=await handoff.observe(scope,ticketId,messageId,
  "I want to start the sandbox purchase and test checkout");
assert.deepEqual(result,{action:"purchase_quotation",explicit:true});
assert.equal(events.length,1);
events.length=0;

// Even a previously requested purchase never interprets the next "yes"
// as a new business request or as authorization.
previous="purchase_quotation";lastText=prompt;
result=await handoff.observe(scope,ticketId,messageId,"yes");
assert.deepEqual(result,{action:"purchase_quotation",explicit:false});
assert.equal(events.length,0);

console.log("Verified quote checkout handoff PASS: contextual request only; no consent/dispatch");
