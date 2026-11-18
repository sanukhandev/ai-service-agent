#!/usr/bin/env node
/** Provider-free transcript regressions for Sara's natural conversation facts. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {AgentToolRegistry} from "../services/api/dist/agent/tool-registry.js";
import {registerIntentTools} from "../services/api/dist/agent/intent-tools.js";
import {validateConversationFact, normalizeContactPhone,
  extractCompoundPackageFacts} from "../services/api/dist/runtime/fact-validation.js";
import {recoverSourcedAnswer} from "../services/api/dist/runtime/chat-fact-reconciliation.js";
import {shouldShowAuthoritativeStatus,isConversationContinuation} from "../services/api/dist/runtime/conversation-action-handoff.js";

const phone=(raw)=>normalizeContactPhone(raw);
assert.deepEqual({status:phone("-4957").status,reason:phone("-4957").reasonCode},
  {status:"rejected",reason:"PHONE_LENGTH_OR_PREFIX"});
for(const raw of ["84046798","585751302"])
  assert.equal(phone(raw).reasonCode,"PHONE_COUNTRY_REQUIRED");
assert.equal(phone("+971585751302").value,"+971585751302");
assert.equal(phone("+971 58 575 1302").value,"+971585751302");
assert.equal(phone("00971585751302").value,"+971585751302");
assert.equal(phone("+97158575").status,"rejected");
assert.equal(phone("+914374384398").status,"accepted");
assert.equal(validateConversationFact("customer_name","Tanisha","text").status,"accepted");
assert.equal(validateConversationFact("shareholder_count",0,"number").status,"needs_clarification");
assert.equal(validateConversationFact("shareholder_count","1","number").value,1);
assert.equal(validateConversationFact("shareholder_nationality","indi","text").status,"needs_clarification");
assert.equal(validateConversationFact("business_activity","IT COMPANY","text").status,"needs_clarification");
assert.equal(validateConversationFact("business_activity","IT consulting services","text").status,"accepted");
assert.equal(validateConversationFact("customer_email","Test@Example.COM","email").value,"test@example.com");
assert.equal(validateConversationFact("customer_email","test@x.com\\","email").status,"needs_clarification");
assert.deepEqual(extractCompoundPackageFacts("2 VISA 2 YEARS"),
  [{key:"visa_count",value:2},{key:"term_years",value:2}]);
assert.deepEqual(extractCompoundPackageFacts("How much for 2 visas for 2 years?"),[]);

const state={activeIntent:"company_formation",requestedAction:"generate_quote",
  knownFacts:{},missingRequirements:["business_activity","visa_count","term_years"]};
const direct=(text,previousAssistant)=>recoverSourcedAnswer({
  ...state,customerText:text,previousAssistant,
});
assert.deepEqual(direct("IT consulting services","What business activity will your company perform?"),
  [{key:"business_activity",value:"IT consulting services"}]);
assert.deepEqual(direct("585751302","What contact phone number should ANCFZ use?"),
  [{key:"customer_phone",value:"585751302"}]);
assert.deepEqual(direct("2 VISA 2 YEARS",null),[
  {key:"visa_count",value:2},{key:"term_years",value:2}]);
assert.deepEqual(direct("YES","What contact phone number should ANCFZ use?"),[]);
assert.deepEqual(direct("What about 2 visas?","What business activity?"),[]);
assert.deepEqual(recoverSourcedAnswer({...state,activeIntent:null,
  previousAssistant:"What business activity?",customerText:"IT services"}),[]);

const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const saved=new Map();
const catalog={listIntents:async()=>[{
  key:"company_formation",name:"Company formation",description:"",
  examplePhrases:[],allowedActions:["create_lead","generate_quote"],
  requirements:["business_activity","visa_count","term_years","preferred_company_name",
    "shareholder_nationality","shareholder_count","office_preference","customer_email"]
    .map(key=>({key,label:key,type:["visa_count","term_years","shareholder_count"].includes(key)
      ?"number":key==="customer_email"?"email":"text",requiredFor:["generate_quote","create_lead"]})),
}],listOfferings:async()=>[]};
const facts={
  listFacts:async()=>[...saved].map(([key,value])=>({key,value,
    verification:"customer_stated",sourceMessageId:sourceId,updatedAt:new Date().toISOString()})),
  recordCustomerFacts:async(_a,_t,source,entries)=>{
    assert.equal(source,sourceId,"All recorded facts must be customer-sourced");
    for(const entry of entries)saved.set(entry.key,entry.value);
    return entries.map(({key,value})=>({key,value,verification:"customer_stated",
      sourceMessageId:source,updatedAt:new Date().toISOString()}));
  },
};
const registry=new AgentToolRegistry(),emitted=[];
registerIntentTools(registry,catalog,facts,{selectIntent:async()=>({intentKey:"company_formation",status:"active"})},
  undefined,undefined,issues=>emitted.push(...issues));
const ctx={agentId,ticketId:sourceId,sourceCustomerMessageId:sourceId,
  principalId:"ticket:"+sourceId,intentCatalogRevision:"1",offeringCatalogRevision:"1",
  authorizedToolNames:new Set(["record_ticket_facts"])};
const submit=async(entries)=>registry.execute({
  callId:"test",name:"record_ticket_facts",
  argumentsJson:JSON.stringify({intentKey:"company_formation",facts:entries}),
},ctx);
let output=await submit([
  {key:"business_activity",value:"IT consulting services"},
  {key:"customer_phone",value:"-4957"},
  {key:"visa_count",value:"2"},
  {key:"term_years",value:"2"},
]);
assert.equal(output.ok,true);
assert.equal(output.data.status,"partially_recorded");
assert.deepEqual(output.data.facts.map(f=>f.key),
  ["business_activity","visa_count","term_years"]);
assert.equal(output.data.issues[0].reasonCode,"PHONE_LENGTH_OR_PREFIX");
assert.equal(saved.get("business_activity"),"IT consulting services");
assert.equal(saved.get("visa_count"),2);
assert.equal(saved.get("customer_phone"),undefined);
assert.equal(emitted.at(-1).key,"customer_phone");
output=await submit([{key:"customer_phone",value:"585751302"}]);
assert.equal(output.data.status,"needs_clarification");
assert.equal(output.data.issues[0].reasonCode,"PHONE_COUNTRY_REQUIRED");
output=await submit([{key:"customer_phone",value:"+971585751302"}]);
assert.equal(output.data.status,"recorded_as_customer_stated");
assert.equal(saved.get("customer_phone"),"+971585751302");
output=await submit([{key:"business_activity",value:"IT company"}]);
assert.equal(output.data.issues[0].reasonCode,"BUSINESS_ACTIVITY_TOO_BROAD");
assert.equal(saved.get("business_activity"),"IT consulting services",
  "An ambiguous correction must never erase the last valid fact");
assert.equal(isConversationContinuation("ok proceed",null),true);
assert.equal(isConversationContinuation("yes","Would you like to prepare a quotation?"),true);
assert.equal(isConversationContinuation("yes","Would you like the document requirements explained?"),false);
assert.equal(isConversationContinuation("yes","What is your email?"),false);
const statuses={stage:"lead_facts",response:"What is your email?",missingCount:2,
  missingKeys:["customer_email"]};
assert.equal(shouldShowAuthoritativeStatus("continue",true,statuses),false,
  "Node must never replace natural language with a missing-field question");
assert.equal(shouldShowAuthoritativeStatus("What is an invoice?",false,
  {...statuses,stage:"invoice_processing"}),false,
  "An unrelated FAQ should not be hijacked by previous workflow state");
assert.equal(shouldShowAuthoritativeStatus("Please explain checkout",false,
  {...statuses,stage:"payment_processing"}),false,
  "Informational questions must not be overwritten by payment state");
assert.equal(shouldShowAuthoritativeStatus("Please check my invoice status",true,
  {...statuses,stage:"invoice_processing"}),true);

const journey=readFileSync("services/api/src/runtime/chat-journey.ts","utf8");
assert.ok(!journey.includes('const questions:[string[],string][]'),
  "No hardcoded quotation questionnaire is allowed");
const worker=readFileSync("services/api/src/runtime/turn-worker.ts","utf8");
assert.ok(!worker.includes("shouldUseHandoff("));
assert.match(worker,/responseText=result\.text/);
assert.match(worker,/validationIssues/);
assert.match(worker,/shouldPrepare/);
assert.match(worker,/recoverSourcedAnswer/);
console.log("Natural conversation facts PASS: mixed input, international phone recovery, direct answers, action guards and no scripted questions");
