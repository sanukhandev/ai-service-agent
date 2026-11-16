#!/usr/bin/env node
/** Provider-free regression for the real consent validator.
 * Previous code examined only the latest two messages and rejected valid
 * explicit approval when an unrelated lifecycle notice was interleaved. */
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {ChatJourney, LEAD_QUOTE_APPROVAL} from "../services/api/dist/runtime/chat-journey.js";
import {workerTicketScope} from "../services/api/dist/repositories/types.js";

const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticketId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const proposalId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const customerId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const proposalData={
  lead:{name:"Synthetic Tester",email:"tester@example.invalid",company:"Example Company",
    phone:"+971500000000",description:"Software services; Visa count: 1; Term years: 1"},
  offeringKey:"visa_1_y1",priceRevision:1,amount:"10800.00",currency:"AED",
  visaCount:1,termYears:1,officePreference:"shared_office",conditions:"Synthetic test rate",
};
const digest=data=>createHash("sha256").update(JSON.stringify(data)).digest("hex");
const proposalEvent={id:proposalId,ticket_id:ticketId,
  payload:{kind:"lead_quote",data:proposalData,fingerprint:digest(proposalData)},sequence:"2"};
const displayed="**Review your ANCFZ enquiry and quotation**\nProposal reference: "+proposalId+
  '\nTo approve, reply: "'+LEAD_QUOTE_APPROVAL+'"';
const scope=workerTicketScope(agentId,ticketId);

async function scenario({messageText=LEAD_QUOTE_APPROVAL,notice=null,
  interveningCustomer=false,stale=false,previousApproval=false,visible=true}={}){
  const state={notices:0,consents:0};
  const messages=[{id:randomUUID(),role:"assistant",content:displayed,message_sequence:"10"}];
  if(!visible)messages[0].content="Unrelated assistant message";
  if(notice)messages.push({id:randomUUID(),role:"assistant",
    content:notice,message_sequence:"11"});
  if(interveningCustomer)messages.push({id:randomUUID(),role:"customer",
    content:"I want to change my package",message_sequence:"12"});
  messages.push({id:customerId,role:"customer",
    content:messageText,message_sequence:interveningCustomer?"13":"12"});
  const client={query:async(sql,params=[])=>{
    if(sql.startsWith("SELECT * FROM tickets"))
      return {rows:[{id:ticketId,status:"processing"}]};
    if(sql.includes("SELECT agent_key FROM agents"))
      return {rows:[{agent_key:"ancfz"}]};
    if(sql.includes("FROM ticket_events WHERE agent_id")&&sql.includes("event_type IN"))
      return {rows:[proposalEvent]};
    if(sql.includes("FROM ticket_events WHERE agent_id")&&sql.includes("event_type=$3")){
      if(params[2]==="chat.lead_quote.proposed")return {rows:[proposalEvent]};
      if(params[2]==="chat.lead_quote.consented" && previousApproval)
        return {rows:[{id:randomUUID(),payload:{proposalId},sequence:"3"}]};
      return {rows:[]};
    }
    if(sql.includes("FROM ticket_messages")&&sql.includes("id=$3")&&
       sql.includes("role='customer'"))return {rows:messages.filter(x=>x.id===params[2])
         .map(x=>({id:x.id,message_sequence:x.message_sequence}))};
    if(sql.includes("FROM ticket_messages")&&sql.includes("position($4 IN content)"))
      return {rows:messages.filter(x=>x.role==="assistant"&&
        Number(x.message_sequence)<Number(params[2])&&
        x.content.includes(params[3])&&x.content.includes(params[4]))
        .sort((a,b)=>Number(b.message_sequence)-Number(a.message_sequence))
        .slice(0,1)};
    if(sql.includes("FROM ticket_messages")&&sql.includes("message_sequence>$3::bigint"))
      return {rows:messages.filter(x=>Number(x.message_sequence)>Number(params[2])&&
        Number(x.message_sequence)<Number(params[3]))
        .map(x=>({role:x.role,content:x.content}))};
    if(sql.startsWith("UPDATE tickets SET last_event_sequence"))
      return {rows:[{last_event_sequence:"4"}]};
    if(sql.startsWith("INSERT INTO ticket_events")){
      state.consents++;
      assert.equal(params[3],"chat.lead_quote.consented");
      const body=JSON.parse(params[4]);
      assert.equal(body.proposalId,proposalId);
      assert.equal(body.sourceMessageId,customerId);
      return {rows:[{id:randomUUID(),ticket_id:ticketId,sequence:"4",
        event_type:"chat.lead_quote.consented",payload:body,created_at:new Date()}]};
    }
    throw Error("Unexpected SQL in consent regression: "+sql.slice(0,180));
  }};
  const db={withAgent:async(id,fn)=>{
    assert.equal(id,agentId);
    return fn(client);
  }};
  const journey=new ChatJourney(db);
  // Model facts/catalog in this mock are frozen to the identical, consented
  // snapshot; independent state regression covers worker and provider gates.
  journey.leadQuoteData=async()=>stale?{...proposalData,amount:"10900.00"}:proposalData;
  return {result:()=>journey.accept(scope,ticketId,customerId,messageText),state};
}

// The user's failing transcript had precisely this pattern. A lifecycle
// notice does not revoke an otherwise exact authorization.
{
  const a=await scenario({notice:"Your ticket information is saved."});
  assert.equal(await a.result(),"lead_quote");
  assert.equal(a.state.consents,1);
}
{
  const a=await scenario();
  assert.equal(await a.result(),"lead_quote");
  assert.equal(a.state.consents,1);
}
{
  const a=await scenario({messageText:LEAD_QUOTE_APPROVAL.slice(0,-1)});
  assert.equal(await a.result(),"lead_quote","A missing terminal period must not prevent exact scoped consent");
  assert.equal(a.state.consents,1);
}
{
  const a=await scenario({messageText:"yes"});
  assert.equal(await a.result(),"lead_quote");
  assert.equal(a.state.consents,1);
}
{
  const a=await scenario({messageText:"yes",notice:"An unrelated background update."});
  assert.equal(await a.result(),null,"Short assent must not cross an assistant notice");
  assert.equal(a.state.consents,0);
}
for(const opts of [{interveningCustomer:true},{visible:false}]){
  const a=await scenario(opts);
  await assert.rejects(a.result(),e=>e.code==="CONFLICT"&&
    /CHAT_APPROVAL_(CUSTOMER_INTERVENED|NOT_DISPLAYED)/.test(e.message));
  assert.equal(a.state.consents,0);
}
{
  const a=await scenario({stale:true});
  await assert.rejects(a.result(),e=>e.code==="CONFLICT"&&
    e.message==="CHAT_APPROVAL_SNAPSHOT_CHANGED");
  assert.equal(a.state.consents,0);
}
{
  const a=await scenario({previousApproval:true});
  assert.equal(await a.result(),"lead_quote");
  assert.equal(a.state.consents,0,"Idempotent approval cannot duplicate consent event");
}
console.log("Chat consent reconciliation PASS: exact assent, interrupted notice, stale snapshot, source ordering and replay");
