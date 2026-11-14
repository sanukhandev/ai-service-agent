#!/usr/bin/env node
/** Offline ANCFZ invoice/payment workflow contract tests; NO Docker, provider or network calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root=new URL("../infra/n8n/ancfz/",import.meta.url);
const read=name=>JSON.parse(readFileSync(new URL(name,root),"utf8"));
const pdf=read("02-render-pdf.json");
const payment=read("03-mockgateway-payment-link.json");
const verify=read("04-mockgateway-payment-verify.json");
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const code=(wf,name)=>{
  const n=wf.nodes.find(x=>x.name===name);
  assert(n?.type==="n8n-nodes-base.code","Missing n8n Code node "+name);
  return new AsyncFunction("$input","$","Buffer","URL",n.parameters.jsCode);
};
const input=body=>({first:()=>({json:{body}})});
const ticketId="11111111-1111-4111-8111-111111111111";
const quotationId="22222222-2222-4222-8222-222222222222";

for(const wf of [pdf,payment,verify]){
  assert.equal(wf.active,false);
  assert.equal(wf.settings.saveDataSuccessExecution,"none");
  assert.equal(wf.settings.saveDataErrorExecution,"none");
}
const quote={
  agentKey:"ancfz",documentType:"quotation",ticketId,
  documentNumber:"ANCFZ-TEST-Q-"+quotationId,
  customerName:"Test <script>alert(1)</script>",
  currency:"AED",lines:[{label:"Package <script>alert(2)</script>",amount:425.25}],total:425.25,
};
const prepare=code(pdf,"Prepare Escaped HTML");
const quoteRows=await prepare(input(quote),()=>{},Buffer,URL);
assert.equal(quoteRows.length,1);
const html=Buffer.from(quoteRows[0].binary.html.data,"base64").toString("utf8");
assert(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"));
assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
assert(!html.includes("<script>"));
assert(html.includes("QUOTATION"));
assert(!html.includes("TEST PAYMENT INVOICE"));
await assert.rejects(prepare(input({...quote,total:1}),()=>{},Buffer,URL),/Total mismatch/);
await assert.rejects(prepare(input({...quote,lines:[]}),()=>{},Buffer,URL),/Invalid lines/);
await assert.rejects(prepare(input({...quote,ticketId:"unknown"}),()=>{},Buffer,URL),/ticket UUID/);
const invoice={
  ...quote,documentType:"invoice",documentNumber:"ANCFZ-TEST-INV-"+quotationId,
};
await assert.rejects(prepare(input(invoice),()=>{},Buffer,URL),/Invoice blocked/);
await assert.rejects(prepare(input({...invoice,paymentVerified:true}),()=>{},Buffer,URL),/Invoice blocked/);
const evidence={
  status:"verified_test_payment",
  provider:"mockgateway_demo_orders",
  providerReference:"demoOrder_1234567",
  ticketId,quotationId,currency:"AED",amount:"425.25",
};
await assert.rejects(prepare(input({...invoice,paymentVerified:true,paymentEvidence:{...evidence}}),()=>{},Buffer,URL),/Invoice blocked/);
await assert.rejects(prepare(input({...invoice,paymentVerified:true,paymentEvidence:{...evidence,amount:"425.26"}}),()=>{},Buffer,URL),/Invoice blocked/);
await assert.rejects(prepare(input({...invoice,paymentVerified:true,paymentEvidence:{...evidence,ticketId:"other"}}),()=>{},Buffer,URL),/Invoice blocked/);
const accepted=await prepare(input({...invoice,paymentVerified:true,quotationId,paymentEvidence:evidence}),()=>{},Buffer,URL);
const invoiceHtml=Buffer.from(accepted[0].binary.html.data,"base64").toString("utf8");
assert(invoiceHtml.includes("TEST PAYMENT INVOICE"));
assert(invoiceHtml.includes("Not proof of real funds"));
const gotenberg=pdf.nodes.find(x=>x.name==="Gotenberg Private PDF Renderer");
assert.equal(gotenberg?.parameters?.url,"http://gotenberg:3000/forms/chromium/convert/html");
assert.equal(gotenberg?.parameters?.bodyParameters?.parameters?.[0]?.name,"files");
const pkg=code(pdf,"Package PDF Result");
const pdfBytes=Buffer.from("%PDF-1.4\n"+("x".repeat(200))+"\n%%EOF");
const mockThis={helpers:{getBinaryDataBuffer:async()=>pdfBytes}};
const packaged=await pkg.call(mockThis,{first:()=>({})},()=>({first:()=>({json:quoteRows[0].json})}),Buffer,URL);
assert.equal(packaged[0].json.status,"generated");
assert.equal(packaged[0].json.ticketId,ticketId);
assert.deepEqual(Buffer.from(packaged[0].json.pdfBase64,"base64"),pdfBytes);
await assert.rejects(pkg.call({helpers:{getBinaryDataBuffer:async()=>Buffer.from("BAD")}}, {first:()=>({})},()=>({first:()=>({json:quoteRows[0].json})}),Buffer,URL),/Invalid PDF/);

const validatePayment=code(payment,"Validate Authorized Payment");
const authorization={
  agentKey:"ancfz",ticketId,quotationId,externalReference:"ANCFZ-demo-12345678",
  otpVerified:true,customerConsent:true,currency:"AED",amount:"425.25",
  firstName:"Test",email:"test@example.invalid",countryCode:"AE",
};
const val=await validatePayment(input(authorization),()=>{},Buffer,URL);
assert.equal(val[0].json.amount,"425.25");
for (const patch of [
  {otpVerified:false},{customerConsent:false},{amount:"0.00"},{currency:"USD"},
  {amount:"425.251"},{externalReference:"invalid"},{ticketId:"wrong"},
]) await assert.rejects(validatePayment(input({...authorization,...patch}),()=>{},Buffer,URL));
const inspectOrder=code(payment,"Inspect Demo Order Response");
const orderResponse={id:"order_123",ExternalReference:authorization.externalReference,
  Currency:"AED",Amount:"425.25",checkout_url:"https://pay.mockgateway.com/checkout/test123"};
const context=()=>({first:()=>({json:val[0].json})});
const good=(await inspectOrder({first:()=>({json:orderResponse})},context,Buffer,URL))[0].json;
assert.equal(good.orderReference,"order_123");
assert.equal(good.verified,false);
assert.equal(good.status,"checkout_available");
assert.equal(good.paymentUrl,orderResponse.checkout_url);
for(const bad of [
  {Currency:"USD"},{Amount:"425.26"},{ExternalReference:"ANCFZ-other"},
  {checkout_url:"https://evil.example/pay"},
]){
  await assert.rejects(inspectOrder({first:()=>({json:{...orderResponse,...bad}})},context,Buffer,URL));
}
const missingLink=(await inspectOrder({first:()=>({json:{id:"order_123"}})},context,Buffer,URL))[0].json;
assert.equal(missingLink.paymentUrl,null);
assert.equal(missingLink.status,"order_created_checkout_unavailable");

assert(!verify.nodes.some(n=>n.type==="n8n-nodes-base.httpRequest"),"Do not invent a payment status endpoint");
const req=code(verify,"Validate Verification Request");
const v=(await req(input({
  agentKey:"ancfz",ticketId,orderReference:"order_123",
  externalReference:authorization.externalReference,currency:"AED",amount:"425.25",
}),()=>{},Buffer,URL))[0].json;
const reject=code(verify,"Reject Unverified Demo Order");
const status=(await reject({first:()=>({json:v})},()=>({first:()=>({json:v})}),Buffer,URL))[0].json;
assert.equal(status.verified,false);
assert.equal(status.status,"verification_unconfigured");
assert.equal(status.ticketId,ticketId);
console.log("ANCFZ billing offline PASS: escaped quotation/invoice PDF, correlated test-payment evidence, private Gotenberg, order-response validation, fail-closed payment status");
