#!/usr/bin/env node
/** Offline regression: quote confirmation uses the SAME n8n sandbox OTP table
 * adapter as payment, but never forwards the user's real contact email.
 * No live n8n, external network, or actual OTP is generated here. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {quoteMockDeliveryEmail} from "../services/api/dist/runtime/quotation-confirmation.js";

const a="11111111-1111-4111-8111-111111111111";
const b="22222222-2222-4222-8222-222222222222";
const alias=quoteMockDeliveryEmail(a);
assert.equal(alias,"quote-11111111111141118111111111111111@example.invalid");
assert.notEqual(alias,quoteMockDeliveryEmail(b));
assert.match(alias,/^quote-[a-f0-9]{32}@example\.invalid$/);
assert.throws(()=>quoteMockDeliveryEmail("bad-challenge"),/Invalid quotation challenge/);

const node=readFileSync("services/api/src/runtime/quotation-confirmation.ts","utf8");
assert.match(node,/email:quoteMockDeliveryEmail\(challengeId\),otp:code/);
assert.doesNotMatch(node,/email:initiated\.email/);
assert.match(node,/INSERT INTO ticket_quote_confirmation_otps\(id,agent_id,ticket_id,quotation_id,request_id,email,otp_hmac,expires_at\)/);
assert.match(node,/otpHmac\(pepper,challengeId,code\)/);
assert.match(node,/checkOtp\(/);
assert.match(node,/deliveryMode:"mock_datatable"/);
assert.match(node,/answer\.status==="mock_recorded"/);

const payment=readFileSync("services/api/src/runtime/payment-operations.ts","utf8");
assert.match(payment,/requestJson\("ancfz\/otp-email"/);
assert.match(node,/fetch\("http:\/\/n8n:5678\/webhook\/ancfz\/otp-email"/);
const flow=JSON.parse(readFileSync("infra/n8n/ancfz/05-mock-otp-table.json","utf8"));
const hook=flow.nodes.find(n=>n.name==="Receive Node OTP");
const validate=flow.nodes.find(n=>n.name==="Validate Mock OTP");
const write=flow.nodes.find(n=>n.name==="Record OTP in n8n Data Table");
assert.equal(hook?.parameters?.path,"ancfz/otp-email");
assert.equal(hook?.parameters?.authentication,"headerAuth");
assert.equal(write?.parameters?.dataTableId?.value,"ANCFZ_POC_OTPS");
assert.match(validate?.parameters?.jsCode||"",/endsWith\('@example\.invalid'\)/);

// Execute the exact checked-in n8n validation code with a representative
// synthetic payload. The real contact email must be rejected by n8n.
const validateData=new Function("$input",validate.parameters.jsCode);
const body={agentKey:"ancfz",ticketId:a,email:alias,otp:"123456",
  testOnly:true,deliveryMode:"mock_datatable"};
const output=validateData({first:()=>({json:{body}})});
assert.equal(output[0].json.ticketId,a);
assert.match(output[0].json.emailMasked,/@example\.invalid$/);
assert.equal(output[0].json.otp,"123456");
assert.throws(
  ()=>validateData({first:()=>({json:{body:{...body,email:"customer@business.test"}}})}),
  /Synthetic email required/,
);
assert.throws(
  ()=>validateData({first:()=>({json:{body:{...body,testOnly:false}}})}),
  /Synthetic OTP marker required/,
);
console.log("Quote OTP mock Data Table contract PASS: synthetic n8n alias, confirmed contact retained by Node, private hashed verification");
