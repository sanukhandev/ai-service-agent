#!/usr/bin/env node
/** Provider-free regression: the LAST accepted synthetic ID upload presents
 * a durable Node-owned purchase review, not a fabricated customer turn or an
 * authorization/order/OTP/invoice. No Azure, n8n, DB or payment calls. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {ChatJourney} from "../services/api/dist/runtime/chat-journey.js";
import {ConversationActionHandoff} from "../services/api/dist/runtime/conversation-action-handoff.js";
import {PurchaseOperations} from "../services/api/dist/runtime/purchase-operations.js";
import {QuotationOperations} from "../services/api/dist/runtime/quotation-operations.js";
import {TicketMessageRepository} from "../services/api/dist/repositories/messages.js";
import {workerTicketScope} from "../services/api/dist/repositories/types.js";

const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticketId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const quotationId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const uploadId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const scope=workerTicketScope(agentId,ticketId);
let purchase={
  supported:true,confirmed:false,
  missing:["passport"],billingName:null,quotationId,
};
let quote={id:quotationId,state:"verified_completed",pdfAvailable:true};
let sequence=10;
const events=[],assistantNotices=[];
const db={
  withAgent:async(id,fn)=>{
    assert.equal(id,agentId);
    return fn({query:async(sql,params=[])=>{
      if(sql.includes("SELECT * FROM tickets WHERE agent_id"))
        return {rows:[{id:ticketId,status:"open"}]};
      if(sql.includes("UPDATE tickets SET last_event_sequence")){
        sequence++;
        return {rows:[{last_event_sequence:String(sequence)}]};
      }
      if(sql.includes("INSERT INTO ticket_events")){
        const row={
          id:randomUUID(),ticket_id:ticketId,sequence:String(sequence),
          event_type:params[3],payload:JSON.parse(params[4]),created_at:new Date(),
        };
        events.push(row);return {rows:[row]};
      }
      if(sql.includes("SELECT event_type,payload FROM ticket_events")){
        const latest=[...events].reverse()
          .find(x=>["purchase.review.started","customer.action.requested",
            "customer.action.cancelled"].includes(x.event_type));
        return {rows:latest?[latest]:[]};
      }
      throw Error("Unexpected SQL: "+sql.slice(0,130));
    }});
  },
};
const methods=[
  [PurchaseOperations,"read"],[QuotationOperations,"get"],
  [ChatJourney,"prepare"],[TicketMessageRepository,"createAssistantMessage"],
];
const originals=methods.map(([type,method])=>type.prototype[method]);
try{
  PurchaseOperations.prototype.read=async()=>purchase;
  QuotationOperations.prototype.get=async()=>quote;
  ChatJourney.prototype.prepare=async(_scope,_ticket,requested)=>{
    assert.equal(requested,"purchase_quotation");
    return "For sandbox checkout, which synthetic billing email ending in @example.invalid should I use?";
  };
  TicketMessageRepository.prototype.createAssistantMessage=
    async(_scope,_ticket,requestId,content,refs)=>{
      assert.equal(_ticket,ticketId);assert.deepEqual(refs,[]);
      assistantNotices.push({requestId,content});
      return {duplicated:false};
    };
  const journey=new ChatJourney(db);
  assert.equal(await journey.afterDocumentsReceived(scope,ticketId,uploadId),false);
  assert.equal(events.length,0);
  assert.equal(assistantNotices.length,0);

  purchase={...purchase,missing:[],billingName:"Synthetic Tester"};
  quote={...quote,state:"running"};
  assert.equal(await journey.afterDocumentsReceived(scope,ticketId,uploadId),false);
  assert.equal(events.length,0);
  quote={...quote,state:"verified_completed"};
  assert.equal(await journey.afterDocumentsReceived(scope,ticketId,uploadId),true);
  assert.equal(events.length,1);
  assert.equal(events[0].event_type,"purchase.review.started");
  assert.deepEqual(events[0].payload,{
    actionKey:"purchase_quotation",sourceDocumentId:uploadId,quotationId,
  });
  assert.equal(assistantNotices.length,1);
  assert.match(assistantNotices[0].content,/synthetic billing email/i);
  assert.equal(await new ConversationActionHandoff(db).current(scope,ticketId),
    "purchase_quotation");
  assert.equal(events.some(x=>x.event_type.includes("consented")),false);

  purchase={...purchase,confirmed:true};
  assert.equal(await journey.afterDocumentsReceived(scope,ticketId,uploadId),false);
  assert.equal(events.length,1);
  assert.equal(assistantNotices.length,1);

  const api=readFileSync("services/api/src/runtime/app.ts","utf8");
  assert.match(api,/if\(!result\.duplicated\)\s*\{\s*try\s*\{\s*await chatJourney\.afterDocumentsReceived/);
  const props=readFileSync("services/api/src/runtime/chat-journey.ts","utf8");
  assert.match(props,/purchase\.review\.started/);
  assert.doesNotMatch(props.slice(props.indexOf("async afterDocumentsReceived"),props.indexOf("async advance")),
    /\.confirm\(|\.issueOtp\(|\.authorize\(|invoice\.submit\(/);
  console.log("Auto document-review handoff PASS: completed upload issues only review; persisted for next turn");
}finally{
  methods.forEach(([type,method],i)=>{type.prototype[method]=originals[i]});
}
