#!/usr/bin/env node
/** Deterministic provider-free integration of ChatJourney's durable
 * orchestration with existing operation service contracts.
 * No Salesforce, n8n, Foundry or actual payment is contacted. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ChatJourney } from "../services/api/dist/runtime/chat-journey.js";
import { workerTicketScope } from "../services/api/dist/repositories/types.js";
import {quoteDetails,quoteRequirements} from "../services/api/dist/runtime/quote-proposal.js";
import { LeadOperations } from "../services/api/dist/runtime/lead-operations.js";
import { QuotationOperations } from "../services/api/dist/runtime/quotation-operations.js";
import { PurchaseOperations } from "../services/api/dist/runtime/purchase-operations.js";
import { PaymentOperations } from "../services/api/dist/runtime/payment-operations.js";
import { TicketMessageRepository } from "../services/api/dist/repositories/messages.js";

const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticketId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const leadProposalId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const purchaseProposalId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const quotationId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const facts={
  business_activity:"Software solutions",
  shareholder_count:1,shareholder_nationality:"Indian",
  preferred_company_name:"Example IT",
  customer_name:"Test Customer",customer_phone:"+971500000000",
  customer_email:"test@example.invalid",
  visa_count:1,term_years:1,office_preference:"flexi_desk",
};
const lead={
  name:facts.customer_name,company:facts.preferred_company_name,
  phone:facts.customer_phone,email:facts.customer_email,
  description:"Software solutions; Visa count: 1; Term years: 1; Office requested: flexi_desk",
};
const requirementRows=Object.entries(facts)
  .filter(([k])=>!k.startsWith("customer_")||k==="customer_email")
  .map(([requirement_key,value])=>({requirement_key,label:requirement_key,
    value,verification_status:"customer_stated"}));
const proposal=quoteDetails("Licence and incorporation documents.",
  quoteRequirements(requirementRows),"Desk upgrade not priced");
const leadQuoteData={lead,offeringKey:"visa_1_y1",
  offeringLabel:"1 Visa — 1 Year",priceRevision:1,
  amount:"7500.00",currency:"AED",visaCount:1,termYears:1,
  officePreference:"flexi_desk",conditions:"Desk upgrade not priced",proposal};
const purchaseData={
  quotationId,amount:"7500.00",currency:"AED",
  billingName:"Test Customer",testEmail:"billing@example.invalid",
};
const hash=data=>createHash("sha256").update(JSON.stringify(data)).digest("hex");
let approvals=[{
  ticket_id:ticketId,proposal_id:leadProposalId,kind:"lead_quote",
  proposal:{kind:"lead_quote",data:leadQuoteData,fingerprint:hash(leadQuoteData)},
}];
let leadState=null,quotation=null,confirmed=false,otpMarker=null;
let otpRowPersisted=false,otpRetryCount=0,otpRetryLast=null,failPreInsert=false;
let leadSubmits=0,quoteSubmits=0,purchaseConfirms=0,otpIssues=0;
let seq=5;
const query=async(sql,params=[])=>{
  if(sql.includes("SELECT * FROM tickets WHERE agent_id"))
    return {rows:[{id:ticketId,status:"open"}]};
  if(sql.includes("SELECT a.ticket_id,p.id AS proposal_id"))
    return {rows:approvals};
  if(sql.includes("SELECT agent_key FROM agents WHERE id=$1 AND status='active'"))
    return {rows:[{agent_key:"ancfz"}]};
  if(sql.includes("SELECT i.allowed_actions AS actions FROM tickets"))
    return {rows:[{actions:["create_lead","generate_quote","purchase_quotation"]}]};
  if(sql.includes("SELECT i.intent_key,i.allowed_actions FROM tickets"))
    return {rows:[{intent_key:"company_formation",
      allowed_actions:["create_lead","generate_quote","purchase_quotation"]}]};
  if(sql.includes("SELECT fact_key,value,verification_status FROM ticket_facts"))
    return {rows:Object.entries(facts).map(([fact_key,value])=>({
      fact_key,value,verification_status:"customer_stated",
    }))};
  if(sql.includes("SELECT DISTINCT r.requirement_key"))
    return {rows:Object.keys(facts).filter(k=>!k.startsWith("customer_") ||
      k==="customer_email").map(requirement_key=>({requirement_key}))};
  if(sql.includes("SELECT req.requirement_key,req.label,tf.value"))
    return {rows:requirementRows};
  if(sql.includes("SELECT o.offering_key,o.label,o.description,p.amount::text"))
    return {rows:[{offering_key:"visa_1_y1",label:"1 Visa — 1 Year",
      description:"Licence and incorporation documents.",revision:1,
      amount:"7500.00",currency:"AED",conditions:"Desk upgrade not priced"}]};
  if(sql.includes("SELECT id,ticket_id,payload,sequence::text FROM ticket_events"))
    return {rows:otpMarker?[otpMarker]:[]};
  if(sql.includes("SELECT 1 FROM ticket_payment_otps"))
    return {rows:otpRowPersisted?[{id:"existing-otp"}]:[]};
  if(sql.includes("SELECT count(*)::int AS attempts")){
    const last=otpRetryLast??otpMarker?.created_at;
    return {rows:[{attempts:(otpMarker?1:0)+otpRetryCount,
      ready:Boolean(last&&Date.now()-last.getTime()>90000)}]};
  }
  if(sql.includes("UPDATE tickets SET last_event_sequence")){
    seq++;return {rows:[{last_event_sequence:String(seq)}]};
  }
  if(sql.includes("INSERT INTO ticket_events")){
    const row={id:randomUUID(),ticket_id:ticketId,sequence:String(seq),
      event_type:params[3],payload:JSON.parse(params[4]),created_at:new Date()};
    if(row.event_type==="chat.otp.dispatch_started")otpMarker=row;
    if(row.event_type==="chat.otp.preinsert_retry_started"){
      otpRetryCount++;otpRetryLast=row.created_at;
    }
    return {rows:[row]};
  }
  throw Error("Unexpected mock SQL: "+sql.slice(0,125));
};
const client={query};
const db={
  pool:{query:async()=>({rows:[{id:agentId}]})},
  withAgent:async(id,fn)=>{
    assert.equal(id,agentId);
    return fn(client);
  },
};
const originals=[
  [LeadOperations,"list"],[LeadOperations,"submit"],
  [QuotationOperations,"get"],[QuotationOperations,"options"],
  [QuotationOperations,"submit"],[PurchaseOperations,"read"],
  [PurchaseOperations,"confirm"],[PaymentOperations,"issueOtp"],
  [TicketMessageRepository,"createAssistantMessage"],
].map(([klass,key])=>[klass,key,klass.prototype[key]]);
const envNames=[
  "APP_ENV","ANCFZ_LEAD_DISPATCH_ENABLED","ANCFZ_QUOTE_DISPATCH_ENABLED",
  "ANCFZ_PAYMENT_DISPATCH_ENABLED","ANCFZ_TEST_OTP_ENABLED",
  "ANCFZ_OTP_MOCK_ENABLED","ANCFZ_N8N_WEBHOOK_SECRET","ANCFZ_OTP_PEPPER",
];
const previous=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
const problems=[];
try{
  Object.assign(process.env,{
    APP_ENV:"development",ANCFZ_LEAD_DISPATCH_ENABLED:"true",
    ANCFZ_QUOTE_DISPATCH_ENABLED:"true",
    ANCFZ_PAYMENT_DISPATCH_ENABLED:"true",ANCFZ_TEST_OTP_ENABLED:"true",
    ANCFZ_OTP_MOCK_ENABLED:"true",
    ANCFZ_N8N_WEBHOOK_SECRET:"s".repeat(32),ANCFZ_OTP_PEPPER:"p".repeat(32),
  });
  LeadOperations.prototype.list=async()=>leadState?[{operation:"ancfz_salesforce_lead",state:leadState}]:[];
  LeadOperations.prototype.submit=async(_scope,_ticket,input)=>{
    assert.equal(input.requestId,leadProposalId);
    assert.equal(input.email,lead.email);
    assert.equal(input.consent,true);
    leadSubmits++;leadState="queued";return {duplicated:false};
  };
  QuotationOperations.prototype.get=async()=>quotation;
  QuotationOperations.prototype.options=async()=>({enabled:true,leadVerified:true,
    options:[{offeringKey:"visa_1_y1",priceRevision:1,amount:"7500.00",currency:"AED"}]});
  QuotationOperations.prototype.submit=async(_scope,_ticket,input,expected)=>{
    assert.equal(leadState,"verified_completed");
    assert.equal(input.offeringKey,"visa_1_y1");
    assert.deepEqual(expected,{amount:"7500.00",currency:"AED",priceRevision:1});
    quoteSubmits++;
    quotation={id:quotationId,state:"queued",pdfAvailable:false};
    return {duplicated:false};
  };
  PurchaseOperations.prototype.read=async()=>({confirmed});
  PurchaseOperations.prototype.confirm=async(_scope,_ticket,payload)=>{
    assert.equal(payload.quotationId,quotationId);
    assert.equal(payload.amount,"7500.00");
    purchaseConfirms++;confirmed=true;return {confirmed:true};
  };
  PaymentOperations.prototype.issueOtp=async(_scope,_ticket,payload)=>{
    assert.equal(payload.email,"billing@example.invalid");
    assert.equal(payload.quotationId,quotationId);
    otpIssues++;
    if(failPreInsert)throw Error("Simulated pre-insert failure");
    return {challengeId:randomUUID(),status:"mock_recorded"};
  };
  TicketMessageRepository.prototype.createAssistantMessage=async()=>({duplicated:false});
  const journey=new ChatJourney(db);
  const log=(detail,message)=>problems.push({detail,message});
  // A mononym is an acceptable sourced chat fact, never a dispatchable
  // Salesforce lead or a combined enquiry/quotation consent proposal.
  const scope=workerTicketScope(agentId,ticketId);
  facts.customer_name="Test";
  const notReady=await journey.prepare(scope,ticketId,"generate_quote");
  assert.equal(notReady,null,"Missing surname must not cause Node to emit a form question or proposal");
  assert.equal(leadSubmits,0,"No Salesforce submission when surname is missing");
  facts.customer_name="Test Customer";
  facts.customer_phone="585751302";
  assert.equal(await journey.prepare(scope,ticketId,"generate_quote"),null,
    "A country-less phone must not reach Salesforce/quotation consent");
  facts.customer_phone="+971500000000";
  const prepared=await journey.prepare(scope,ticketId,"generate_quote");
  assert.match(prepared,/Review your ANCFZ enquiry and quotation/);
  await journey.advance(log);
  assert.equal(leadSubmits,1);
  assert.equal(quoteSubmits,0,"No quotation before a verified CRM lead");
  await journey.advance(log);
  assert.equal(leadSubmits,1,"Never duplicate a queued CRM POST");
  leadState="unknown_outcome";
  await journey.advance(log);
  assert.equal(quoteSubmits,0,"Never quote against an unknown CRM outcome");
  leadState="verified_completed";
  await journey.advance(log);
  assert.equal(quoteSubmits,1,"A verified CRM lead permits exactly one quote");
  await journey.advance(log);
  assert.equal(quoteSubmits,1,"Existing quote prevents another PDF operation");
  approvals=[{
    ticket_id:ticketId,proposal_id:purchaseProposalId,kind:"purchase_payment",
    proposal:{kind:"purchase_payment",data:purchaseData,fingerprint:hash(purchaseData)},
  }];
  await journey.advance(log);
  assert.equal(purchaseConfirms,1);
  assert.equal(otpIssues,1);
  assert.ok(otpMarker,"OTP dispatch-start marker must be durable before dispatch");
  await journey.advance(log);
  assert.equal(purchaseConfirms,1,"Purchase authorization must not repeat");
  assert.equal(otpIssues,1,"OTP must not be reissued on a repeated worker sweep");
  assert.deepEqual(problems.filter(item=>/paused|failed|postponed/i.test(item.message)),[],
    "No unexpected state-machine errors");
  assert.equal(problems.filter(item=>/Synthetic OTP recorded/.test(item.message)).length,1,
    "Successful one-shot OTP issuance should be observed once");
  // A pre-insert crash commits the marker but NO OTP row. The durable guard
  // must permit bounded recovery after cooling down, without reusing consent.
  otpMarker=null;otpRowPersisted=false;otpRetryCount=0;otpRetryLast=null;
  otpIssues=0;failPreInsert=true;
  await journey.advance(log);
  assert.equal(otpIssues,1);
  assert.ok(otpMarker,"Crash marker is retained for the existing ticket");
  await journey.advance(log);
  assert.equal(otpIssues,1,"A fresh marker must not be retried immediately");
  otpMarker.created_at=new Date(Date.now()-120_000);
  failPreInsert=false;
  await journey.advance(log);
  assert.equal(otpIssues,2,"A stale pre-insert marker with no row may recover");
  assert.equal(otpRetryCount,1,"Retry must be recorded durably");
  await journey.advance(log);
  assert.equal(otpIssues,2,"Recovery marker cooldown prevents repeated dispatch");
  otpRowPersisted=true;
  otpRetryLast=new Date(Date.now()-120_000);
  await journey.advance(log);
  assert.equal(otpIssues,2,"An existing OTP row must forbid another issuance");
  // The database privilege fix grants one additional bounded recovery for
  // tickets that exhausted their earlier two attempts before that fix.
  otpRowPersisted=false;otpRetryCount=2;
  otpRetryLast=new Date(Date.now()-120_000);
  await journey.advance(log);
  assert.equal(otpIssues,3,"One additional no-row recovery repairs the old stuck ticket");
  assert.equal(otpRetryCount,3);
  otpRetryLast=new Date(Date.now()-120_000);
  await journey.advance(log);
  assert.equal(otpIssues,3,"The expanded retry cap remains strict");
  assert.equal(problems.filter(item=>item.detail.reason==="DATABASE_ERROR").length,0,
    "No unexpected database failure is allowed");
  assert.equal(problems.filter(item=>item.detail.reason==="UNEXPECTED").length,1,
    "The pre-insert failure is surfaced without logging private billing facts");
}finally{
  for(const [klass,key,fn] of originals)klass.prototype[key]=fn;
  for(const name of envNames){
    if(previous[name]===undefined)delete process.env[name];
    else process.env[name]=previous[name];
  }
}
console.log("Chat journey state transitions PASS: CRM lead/unknown stop/quote/purchase/OTP duplicate safety");
