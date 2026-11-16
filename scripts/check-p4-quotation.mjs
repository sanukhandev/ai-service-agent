#!/usr/bin/env node
/** P4 offline contracts: no n8n/Foundry/Gotenberg network. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {quoteRequirements,quoteDetails,quoteDetailsMarkdown,
  QUOTATION_SCOPE_NOTICE} from "../services/api/dist/runtime/quote-proposal.js";
import { parseQuoteRequest,quoteDispatchEnabled,QUOTATION_ACKNOWLEDGMENT } from "../services/api/dist/runtime/quotation-operations.js";
import { verifyQuotationPdf } from "../services/api/dist/runtime/n8n-quote-worker.js";

const input={
  requestId:"11111111-1111-4111-8111-111111111111",
  offeringKey:"visa_2_y1",customerName:"POC Customer",
  acknowledged:true,acknowledgmentText:QUOTATION_ACKNOWLEDGMENT,
};
assert.equal(parseQuoteRequest(input).offeringKey,"visa_2_y1");
assert.throws(()=>parseQuoteRequest({...input,acknowledged:false}));
assert.throws(()=>parseQuoteRequest({...input,acknowledgmentText:"yes"}));
assert.throws(()=>parseQuoteRequest({...input,amount:0.01}));
assert.throws(()=>parseQuoteRequest({...input,offeringKey:"__unauthorized"}));
assert.equal(quoteDispatchEnabled({ANCFZ_QUOTE_DISPATCH_ENABLED:"false",ANCFZ_N8N_WEBHOOK_SECRET:"z".repeat(32)}),false);
assert.equal(quoteDispatchEnabled({ANCFZ_QUOTE_DISPATCH_ENABLED:"true",ANCFZ_N8N_WEBHOOK_SECRET:"short"}),false);
assert.equal(quoteDispatchEnabled({ANCFZ_QUOTE_DISPATCH_ENABLED:"true",ANCFZ_N8N_WEBHOOK_SECRET:"z".repeat(32)}),true);
const ticketId="22222222-2222-4222-8222-222222222222";
const documentNumber="ANCFZ-TEST-Q-33333333-3333-4333-8333-333333333333";
const claim={ticketId,documentNumber};
const bytes=Buffer.from("%PDF-1.4\n"+("0".repeat(150))+"\n%%EOF\n");
const data={
  status:"generated",documentType:"quotation",ticketId,documentNumber,
  mimeType:"application/pdf",pdfBase64:bytes.toString("base64"),
};
assert.equal(verifyQuotationPdf(data,claim)?.bytes.toString("hex"),bytes.toString("hex"));
assert.equal(verifyQuotationPdf({...data,ticketId:"other"},claim),null);
assert.equal(verifyQuotationPdf({...data,documentType:"invoice"},claim),null);
assert.equal(verifyQuotationPdf({...data,pdfBase64:Buffer.from("not a pdf").toString("base64")},claim),null);
assert.equal(verifyQuotationPdf({...data,pdfBase64:"!!!"},claim),null);
assert.equal(verifyQuotationPdf({...data,status:"accepted"},claim),null);
assert.equal(verifyQuotationPdf(null,claim),null);
// Source-grounded, deterministic proposal fields. Private OCR/OTP data and
// disputed facts never become customer-facing quotation requirements.
const requirements=quoteRequirements([
  {requirement_key:"office_preference",label:"Which workspace?",value:"private_office",verification_status:"customer_stated"},
  {requirement_key:"visa_count",label:"Visas?",value:2,verification_status:"customer_stated"},
  {requirement_key:"business_activity",label:"Activity?",value:"Software development",verification_status:"customer_stated"},
  {requirement_key:"customer_email",label:"Contact email?",value:"test@example.invalid",verification_status:"customer_stated"},
  {requirement_key:"passport",label:"Passport",value:"PASSPORT-PRIVATE",verification_status:"verified"},
  {requirement_key:"term_years",label:"Term",value:1,verification_status:"disputed"},
  {requirement_key:"shareholder_count",label:"Shareholders",value:0,verification_status:"customer_stated"},
]);
assert.deepEqual(requirements.map(x=>x.label),[
  "Business activity","Number of shareholders","Requested residence visas",
  "Preferred workspace","Enquiry contact email",
]);
assert(!JSON.stringify(requirements).includes("PASSPORT-PRIVATE"));
assert(!requirements.some(x=>x.label==="Licence term (years)"));
assert.equal(requirements[1].value,"0");
const details=quoteDetails(
  "Licence and incorporation docs; health insurance excluded.",
  requirements,"Non-binding test conditions.",
);
const rendered=quoteDetailsMarkdown(details);
assert.match(rendered,/Software development/);
assert.match(rendered,/health insurance excluded/);
assert.match(rendered,/Non-binding test conditions/);
assert.match(rendered,/workspace is a customer request/i);
assert.match(QUOTATION_SCOPE_NOTICE,/non-binding test quotation/i);
const source=readFileSync("services/api/src/runtime/quotation-operations.ts","utf8");
assert.match(source,/const proposal=quoteDetails\(chosen\.description/);
assert.match(source,/await quoteRequirementsTx\(client,scope\.agentId,ticketId\)/);
assert.match(source,/lines:\[\{label:chosen\.label,amount\}\],total:amount,proposal/);
const chat=readFileSync("services/api/src/runtime/chat-journey.ts","utf8");
assert.match(chat,/quoteDetailsMarkdown\(x\.proposal\)/);
assert.match(chat,/offer ingLabel/.source.replace("offer ing","offering"));
// Preserve pre-authorized quote/lead snapshot and exact purchase consent.
console.log("P4 quotation safety PASS: authoritative price, scoped requirement/scope snapshots, exact consent, correlated PDF");
