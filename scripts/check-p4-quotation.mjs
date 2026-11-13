#!/usr/bin/env node
/** P4 offline contracts: no n8n/Foundry/Gotenberg network. */
import assert from "node:assert/strict";
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
console.log("P4 quotation safety PASS: customer acknowledgment, no client price, bounded correlated PDF, disabled default");
