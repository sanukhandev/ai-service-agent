#!/usr/bin/env node
/** Offline guard for natural quoted-workflow handoff; no Foundry or provider calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  ConversationActionHandoff, requestedBusinessAction, nextQuestion, shouldUseHandoff,
} from "../services/api/dist/runtime/conversation-action-handoff.js";
import { IntentActionOperations } from "../services/api/dist/runtime/intent-action-operations.js";
import { LeadOperations } from "../services/api/dist/runtime/lead-operations.js";
import { QuotationOperations } from "../services/api/dist/runtime/quotation-operations.js";
import { PurchaseOperations } from "../services/api/dist/runtime/purchase-operations.js";
import { PaymentOperations } from "../services/api/dist/runtime/payment-operations.js";

assert.equal(requestedBusinessAction("I want to start a company"),"generate_quote");
assert.equal(requestedBusinessAction("Please help me set up an IT business"),"generate_quote");
assert.equal(requestedBusinessAction("How do I start a company?"),null);
assert.equal(requestedBusinessAction("can you send me a quotation"),"generate_quote");
assert.equal(requestedBusinessAction("can you sen me a pdf?", "generate_quote"),"generate_quote");
assert.equal(requestedBusinessAction("can I have a PDF?",null,true),"generate_quote");
assert.equal(requestedBusinessAction("can I have a PDF?",null,false),null);
assert.equal(requestedBusinessAction("can I have the policy PDF?",null,true),null);
assert.equal(requestedBusinessAction("please prepare an invoice"),"invoice");
assert.equal(requestedBusinessAction("I would like to pay for the package"),"purchase_quotation");
assert.equal(requestedBusinessAction("What steps are needed for licensing?"),null);
assert.equal(requestedBusinessAction("How many visas should I choose?"),null);
assert.equal(requestedBusinessAction("Can you send me the official knowledge article?"),null);
assert.equal(requestedBusinessAction("Can you explain the quotation requirements?"),null);
assert.equal(requestedBusinessAction("How can I generate a formal quotation?"),null);
assert.equal(requestedBusinessAction("I want to know the payment options"),null);
assert.equal(requestedBusinessAction("Please send me a formal quotation"),"generate_quote");
assert.equal(nextQuestion([
  {key:"customer_email",label:"Email?"},{key:"preferred_company_name",label:"Company name?"}
]),"What company name would you like to register?");
assert.equal(shouldUseHandoff("My company is Example IT",false,
  {stage:"lead_facts",response:"Name?",missingCount:3},
  {stage:"lead_facts",response:"Nationality?",missingCount:2}),true);
assert.equal(shouldUseHandoff("Which business structures are available?",false,
  {stage:"lead_facts",response:"Name?",missingCount:3},
  {stage:"lead_facts",response:"Name?",missingCount:3}),false);
assert.equal(shouldUseHandoff("Example IT",false,
  {stage:"lead_facts",response:"Name?",missingCount:3},
  {stage:"lead_facts",response:"Name?",missingCount:3}),true);

const modules=[IntentActionOperations,LeadOperations,QuotationOperations,PurchaseOperations,PaymentOperations];
const methods=["catalog","list","get","read","get"];
const originals=modules.map((c,i)=>c.prototype[methods[i]]);
const envNames=["ANCFZ_LEAD_DISPATCH_ENABLED","ANCFZ_QUOTE_DISPATCH_ENABLED","ANCFZ_N8N_WEBHOOK_SECRET",
  "APP_ENV","ANCFZ_PAYMENT_DISPATCH_ENABLED","ANCFZ_TEST_OTP_ENABLED","ANCFZ_OTP_MOCK_ENABLED","ANCFZ_OTP_PEPPER"];
const prior=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
const scope={agentId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",owner:{kind:"internal"}};
const ticketId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let actionList=[];
let leadState=null;
let quote=null;
let docs={supported:true,missing:["passport","emirates_id"],confirmed:false,readyForOtp:false};
let payments={payments:[],invoice:null};
try {
  process.env.ANCFZ_LEAD_DISPATCH_ENABLED="true";
  process.env.ANCFZ_QUOTE_DISPATCH_ENABLED="true";
  process.env.ANCFZ_N8N_WEBHOOK_SECRET="x".repeat(32);
  process.env.APP_ENV="development";
  process.env.ANCFZ_PAYMENT_DISPATCH_ENABLED="true";
  process.env.ANCFZ_TEST_OTP_ENABLED="true";
  process.env.ANCFZ_OTP_MOCK_ENABLED="true";
  process.env.ANCFZ_OTP_PEPPER="y".repeat(32);
  IntentActionOperations.prototype.catalog=async()=>({intentKey:"company_formation",actions:actionList});
  LeadOperations.prototype.list=async()=>leadState?[{operation:"ancfz_salesforce_lead",state:leadState}]:[];
  QuotationOperations.prototype.get=async()=>quote;
  PurchaseOperations.prototype.read=async()=>docs;
  PaymentOperations.prototype.get=async()=>payments;

  const lead={actionKey:"create_lead",kind:"salesforce_lead",ready:false,
    missing:["preferred_company_name","customer_email","shareholder_nationality"],
    requirements:[
      {key:"preferred_company_name",label:"Preferred company name",present:false},
      {key:"customer_email",label:"Email",present:false},
      {key:"shareholder_nationality",label:"Nationality",present:false},
    ]};
  const quotation={actionKey:"generate_quote",kind:"quotation",ready:true,missing:[],requirements:[]};
  const purchase={actionKey:"purchase_quotation",kind:"purchase",ready:true,missing:[],requirements:[]};
  actionList=[lead,quotation,purchase];
  const handoff=new ConversationActionHandoff({});
  let stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"lead_facts");
  assert.equal(stage.missingCount,3);
  assert.match(stage.response,/company name/i);

  lead.missing=[];lead.requirements=lead.requirements.map(r=>({...r,present:true}));
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"lead_consent");
  leadState="running";
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"lead_processing");
  leadState="unknown_outcome";
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"lead_review");
  leadState="verified_completed";
  quotation.missing=["term_years"];
  quotation.requirements=[{key:"term_years",label:"Term",present:false}];
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"quote_facts");
  quotation.missing=[];quotation.requirements[0].present=true;
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"quote_consent");
  quote={state:"queued",pdfAvailable:false};
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"quote_processing");
  quote={state:"verified_completed",pdfAvailable:true};
  stage=await handoff.status(scope,ticketId,"generate_quote");
  assert.equal(stage.stage,"quote_ready");
  stage=await handoff.status(scope,ticketId,"purchase_quotation");
  assert.equal(stage.stage,"documents_pending");
  docs={supported:true,missing:[],confirmed:false,readyForOtp:false};
  stage=await handoff.status(scope,ticketId,"invoice");
  assert.equal(stage.stage,"purchase_consent");
  docs.confirmed=true;
  docs.readyForOtp=true;
  stage=await handoff.status(scope,ticketId,"invoice");
  assert.equal(stage.stage,"otp_pending");
  payments={payments:[{state:"payment_pending"}],invoice:null};
  stage=await handoff.status(scope,ticketId,"invoice");
  assert.equal(stage.stage,"payment_processing");
  payments={payments:[{state:"payment_declined"}],invoice:null};
  stage=await handoff.status(scope,ticketId,"invoice");
  assert.equal(stage.stage,"payment_review");
  payments={payments:[{state:"verified_test_payment"}],invoice:null};
  stage=await handoff.status(scope,ticketId,"invoice");
  assert.equal(stage.stage,"invoice_processing");
  payments.invoice={pdfAvailable:true};
  stage=await handoff.status(scope,ticketId,"invoice");
  assert.equal(stage.stage,"invoice_ready");
} finally {
  modules.forEach((c,i)=>{c.prototype[methods[i]]=originals[i]});
  for(const k of envNames){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
}

const source=readFileSync("apps/web/lib/chat-display.ts","utf8");
const js=ts.transpileModule(source,{compilerOptions:{
  target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,
}}).outputText;
const helpers={};
new Function("exports",js)(helpers);
const cleaned=helpers.conversationalText(
  "Your quotation is ready 【14:0†source】 [Download your TEST invoice](/api/v1/tickets/t/invoices/i/pdf).");
assert.ok(!cleaned.includes("source"));
assert.ok(!cleaned.includes("Download"));
assert.ok(!cleaned.includes("/api/v1"));
assert.match(cleaned,/quotation is ready/);
const ownTicket="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const wrongTicket="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const quoteId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const quoteLink="[Download verified quotation](/api/v1/tickets/"+ownTicket+"/quotations/"+quoteId+"/pdf)";
const invoiceLink="[Download TEST invoice](/api/v1/tickets/"+ownTicket+"/invoices/"+quoteId+"/pdf)";
assert.equal(helpers.conversationalText(quoteLink,ownTicket),quoteLink);
assert.equal(helpers.conversationalText(invoiceLink,ownTicket),invoiceLink);
assert.ok(!helpers.conversationalText(quoteLink,wrongTicket).includes("Download"));
assert.ok(!helpers.conversationalText(quoteLink).includes("Download"));
assert.ok(!helpers.conversationalText("[Download report](https://private.search.windows.net/file.pdf)",ownTicket)
  .includes("Download report"));
assert.equal(helpers.conversationalText("Visit https://ancfz.example for office hours."),
  "Visit https://ancfz.example for office hours.");
assert.ok(!helpers.conversationalText("See https://private.search.windows.net/download/foo.pdf")
  .includes("search.windows.net"));
const component=readFileSync("apps/web/components/chat-message.tsx","utf8");
assert.match(component,/SHOW_CHAT_SOURCES = process\.env\.NEXT_PUBLIC_SHOW_CHAT_SOURCES === "true"/);
assert.match(component,/conversationalText\(message\.text,\s*ticketId\)/);
assert.match(component,/SHOW_CHAT_SOURCES && references\.length > 0/);
const worker=readFileSync("services/api/src/runtime/turn-worker.ts","utf8");
assert.match(worker,/handoff\.observe\(/);
assert.match(worker,/handoff\.status\(/);
assert.match(worker,/this\.queue\.complete\(turn,responseText,/);
assert.match(worker,/lastCustomerVisibleAssistantReply:displayedAssistant/);
assert.match(worker,/responseText===result\.text\?citations\(result\.sourceReferences\):\[\]/);
const panel=readFileSync("apps/web/components/intent-action-panel.tsx","utf8");
assert.match(panel,/if\(!action\.ready\)return null/);
assert.ok(!panel.includes("To proceed with {action.label}"),
  "Do not show a duplicate list of missing questions beside Sara's chat");
console.log("Natural business action handoff PASS: missing facts, consent, lead, quotation, documents, sandbox payment, invoice and hidden chat sources");
await import("./check-verified-quote-purchase-handoff.mjs");
