#!/usr/bin/env node
/** Deterministic provider-free integration of ChatJourney's durable
 * orchestration with existing operation service contracts.
 * No Salesforce, n8n, Foundry or actual payment is contacted. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ChatJourney } from "../services/api/dist/runtime/chat-journey.js";
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
const leadQuoteData={lead,offeringKey:"visa_1_y1",priceRevision:1,
  amount:"7500.00",currency:"AED",visaCount:1,termYears:1,
  officePreference:"flexi_desk",conditions:"Desk upgrade not priced"};
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
let leadSubmits=0,quoteSubmits=0,purchaseConfirms=0,otpIssues=0;
let seq=5;
const query=async(sql,params=[])=>{
  if(sql.includes("SELECT * FROM tickets WHERE agent_id"))
    return {rows:[{id:ticketId,status:"open"}]};
  if(sql.includes("SELECT a.ticket_id,p.id AS proposal_id"))
    return {rows:approvals};
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
  if(sql.includes("SELECT o.offering_key,p.amount::text"))
    return {rows:[{offering_key:"visa_1_y1",revision:1,amount:"7500.00",
      currency:"AED",conditions:"Desk upgrade not priced"}]};
  if(sql.includes("SELECT id,ticket_id,payload,sequence::text FROM ticket_events"))
    return {rows:otpMarker?[otpMarker]:[]};
  if(sql.includes("SELECT 1 FROM ticket_payment_otps"))
    return {rows:[]};
  if(sql.includes("UPDATE tickets SET last_event_sequence")){
    seq++;return {rows:[{last_event_sequence:String(seq)}]};
  }
  if(sql.includes("INSERT INTO ticket_events")){
    const row={id:randomUUID(),ticket_id:ticketId,sequence:String(seq),
      event_type:params[3],payload:JSON.parse(params[4]),created_at:new Date()};
    if(row.event_type==="chat.otp.dispatch_started")otpMarker=row;
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
    otpIssues++;return {challengeId:randomUUID(),status:"mock_recorded"};
  };
  TicketMessageRepository.prototype.createAssistantMessage=async()=>({duplicated:false});
  const journey=new ChatJourney(db);
  const log=(detail,message)=>problems.push({detail,message});
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
  assert.deepEqual(problems,[],"No unexpected state-machine errors");
}finally{
  for(const [klass,key,fn] of originals)klass.prototype[key]=fn;
  for(const name of envNames){
    if(previous[name]===undefined)delete process.env[name];
    else process.env[name]=previous[name];
  }
}
console.log("Chat journey state transitions PASS: CRM lead/unknown stop/quote/purchase/OTP duplicate safety");
