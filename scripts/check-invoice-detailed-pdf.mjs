#!/usr/bin/env node
/** Invoice detail/privacy regression. Pure offline Node tests: no Azure, n8n
 * service, DB or payment provider calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseInvoiceEmiratesId } from "../services/api/dist/runtime/identity-extractor.js";
import { invoiceQuoteDetails } from "../services/api/dist/runtime/invoice-details.js";

const number="784199912345671";
const result={status:"succeeded",analyzeResult:{documents:[{
  docType:"idDocument",fields:{
    FullName:{valueString:"Test Customer",confidence:0.99},
    DocumentNumber:{valueString:"784-1999-1234567-1",confidence:0.99},
  },
}],content:"784-1999-1234567-1"}};
assert.deepEqual(parseInvoiceEmiratesId(result),
  {fullName:"Test Customer",number,last4:"5671"});
assert.throws(()=>parseInvoiceEmiratesId({...result,analyzeResult:{
  documents:[{docType:"idDocument",fields:{
    FullName:{valueString:"Test Customer"},
    DocumentNumber:{valueString:"123"},
  }}],content:""
}}));
const proposal={
  packageDescription:"Published package; upgrades not included",
  requirements:[
    {label:"Business activity",value:"IT services"},
    {label:"Preferred company name",value:"Demo Company"},
    {label:"Requested residence visas",value:"2"},
    {label:"Licence term (years)",value:"1"},
    {label:"Preferred workspace",value:"Executive office"},
  ],
  priceConditions:"Additional workspaces not priced",
};
const quoteNumber="ANCFZ-TEST-Q-"+randomUUID();
const amount=10800;
const original={
  documentType:"quotation",documentNumber:quoteNumber,
  currency:"AED",total:amount,proposal,
};
assert.deepEqual(invoiceQuoteDetails(original,{
  quotationDocumentNumber:quoteNumber,amount:"10800.00",currency:"AED",
}),proposal);
for(const tampered of [
  {...original,total:9999},
  {...original,documentNumber:"ANCFZ-TEST-Q-"+randomUUID()},
  {...original,documentType:"invoice"},
  {...original,currency:"USD"},
])assert.throws(()=>invoiceQuoteDetails(tampered,{
  quotationDocumentNumber:quoteNumber,amount:"10800.00",currency:"AED",
}),"Reject mismatched immutable quotation scope");

const workflow=JSON.parse(readFileSync("infra/n8n/ancfz/02-render-pdf.json","utf8"));
assert.equal(workflow.settings.saveDataSuccessExecution,"none");
assert.equal(workflow.settings.saveDataErrorExecution,"none");
const jsCode=workflow.nodes.find(node=>node.id==="html")?.parameters.jsCode;
assert.ok(jsCode,"PDF renderer code node missing");
const render=new Function("$input","Buffer",jsCode);
const ticketId=randomUUID();
const quotationId=randomUUID();
const base={
  agentKey:"ancfz",ticketId,quotationId,documentType:"invoice",
  documentNumber:"ANCFZ-TEST-INV-"+randomUUID(),
  customerName:"Test Customer",currency:"AED",
  lines:[{label:"1 Visa — 1 Year",amount}],total:amount,
  proposal,
  paymentVerified:true,paymentEvidence:{
    status:"verified_test_payment",provider:"2checkout_mock",
    providerReference:"REF123456",ticketId,quotationId,
    amount:"10800.00",currency:"AED",
  },
  invoiceIdentity:{emiratesIdNumber:number,emiratesIdLast4:"5671"},
};
function html(body){
  const rows=render({first:()=>({json:{body}})},Buffer);
  return Buffer.from(rows[0].binary.html.data,"base64").toString("utf8");
}
const rendered=html(base);
for(const important of [
  "TEST PAYMENT INVOICE","Published package scope",
  "Business activity","IT services","Preferred company name",
  "Demo Company","Licence term (years)","Preferred workspace",
  "Additional workspaces not priced","784-1999-1234567-1",
  "Quotation reference","REF123456","Independently verified TEST payment",
])assert.ok(rendered.includes(important),"Invoice must include "+important);
assert.ok(!rendered.includes("Next steps (development sandbox)"));
assert.ok(!rendered.includes("Passport Number"));
const fallback=html({...base,invoiceIdentity:{emiratesIdNumber:null,emiratesIdLast4:"5671"}});
assert.match(fallback,/Emirates ID \(last 4 only\)/);
assert.ok(fallback.includes("XXXX-XXXX-XXXX-5671"));
assert.ok(!fallback.includes("784-1999-1234567-1"));
for(const invalid of [
  {...base,paymentVerified:false},
  {...base,paymentEvidence:{...base.paymentEvidence,amount:"1.00"}},
  {...base,invoiceIdentity:{emiratesIdNumber:number,emiratesIdLast4:"9999"}},
  {...base,invoiceIdentity:{emiratesIdNumber:"123456",emiratesIdLast4:"3456"}},
]) assert.throws(()=>html(invalid),"Never render invoices without valid verified payment/ID");
const escaped=html({...base,proposal:{
  ...proposal,requirements:[{label:"Company",value:"<script>alert(1)</script>"}],
}});
assert.ok(escaped.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
assert.ok(!escaped.includes("<script>"));
const quotation=html({...base,documentType:"quotation",documentNumber:quoteNumber,
  paymentVerified:undefined,invoiceIdentity:undefined});
assert.ok(quotation.includes("Next steps (development sandbox)"));
assert.ok(!quotation.includes("Billing identity"));
console.log("Invoice detail and identity PASS: immutable quote, OCR, privacy fallback, escaped HTML, payment gates");
