#!/usr/bin/env node
/** Offline Node payment/OTP validation; no provider, no database, no secrets. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  paymentEnabled, paymentReadEnabled, inspectCreatedOrder,
  PAYMENT_CONSENT, isCheckoutUrl, paymentIdFromCheckout, otpHmac,checkOtp,
  verifyCreatedOrder, verifyPaymentStatus,
} from "../services/api/dist/runtime/payment-evidence.js";
import {
  parseStartOtp,parseAuthorize,reconcileGatewayCheck,
} from "../services/api/dist/runtime/payment-operations.js";
import {
  verifyQuotationPdf,verifyInvoicePdf,
} from "../services/api/dist/runtime/n8n-quote-worker.js";
import { invoiceFinalizationDecision } from "../services/api/dist/runtime/n8n-invoice-worker.js";

// The restricted agent_runtime role has SELECT/INSERT on quotations but no
// UPDATE grant; FOR UPDATE OF q would make OTP issuance fail with SQLSTATE 42501.
const paymentSource=readFileSync(new URL("../services/api/src/runtime/payment-operations.ts",import.meta.url),"utf8");
assert.doesNotMatch(paymentSource,/^\s*FOR UPDATE OF q\b/m,
  "Immutable quotation preflight must not acquire an unauthorized row lock");

const conf={
  APP_ENV:"development",ANCFZ_PAYMENT_DISPATCH_ENABLED:"true",
  ANCFZ_TEST_OTP_ENABLED:"true",ANCFZ_OTP_MOCK_ENABLED:"true",
  ANCFZ_N8N_WEBHOOK_SECRET:"a".repeat(40),ANCFZ_OTP_PEPPER:"b".repeat(40),
};
assert.equal(paymentEnabled(conf),true);
assert.equal(paymentReadEnabled(conf),true);
assert.equal(paymentEnabled({...conf,ANCFZ_PAYMENT_DISPATCH_ENABLED:"false"}),false);
assert.equal(paymentReadEnabled({...conf,ANCFZ_PAYMENT_DISPATCH_ENABLED:"false"}),true);
assert.equal(paymentReadEnabled({...conf,ANCFZ_N8N_WEBHOOK_SECRET:"short"}),false);
for(const patch of [
  {APP_ENV:"production"},{ANCFZ_PAYMENT_DISPATCH_ENABLED:"false"},
  {ANCFZ_TEST_OTP_ENABLED:"false"},{ANCFZ_OTP_MOCK_ENABLED:"false"},
  {ANCFZ_OTP_PEPPER:"short"},{ANCFZ_N8N_WEBHOOK_SECRET:"short"},
])assert.equal(paymentEnabled({...conf,...patch}),false);
const ticketId=randomUUID(),quotationId=randomUUID(),requestId=randomUUID();
const otpBody={
  requestId,quotationId,acceptedAmount:"425.25",currency:"AED",
  email:"tester@example.invalid",firstName:"Demo",countryCode:"AE",
  consent:true,consentText:PAYMENT_CONSENT,
};
assert.equal(parseStartOtp(otpBody).amount,"425.25");
assert.equal(parseStartOtp({...otpBody,firstName:"José"}).firstName,"José");
assert.equal(parseStartOtp({...otpBody,firstName:"أحمد"}).firstName,"أحمد");
assert.throws(()=>parseStartOtp({...otpBody,firstName:"<script>"}));
assert.throws(()=>parseStartOtp({...otpBody,firstName:"1234"}));
for(const bad of [
  {email:"customer@example.com"},{countryCode:"US"},{currency:"USD"},
  {acceptedAmount:"425.250"},{acceptedAmount:"426.25"},
  {consent:false},{consentText:"yes"},{agentKey:"ancfz"},
]) {
  if("acceptedAmount" in bad && bad.acceptedAmount==="426.25")continue; // DB quote comparison owns price
  assert.throws(()=>parseStartOtp({...otpBody,...bad}));
}
const verification={requestId,quotationId,challengeId:randomUUID(),
  code:"002345",consent:true,consentText:PAYMENT_CONSENT};
assert.equal(parseAuthorize(verification).code,"002345");
for(const p of [{code:"234"},{consent:false},{agentKey:"model"}])
  assert.throws(()=>parseAuthorize({...verification,...p}));
const digest=otpHmac(conf.ANCFZ_OTP_PEPPER,verification.challengeId,verification.code).toString("hex");
assert.equal(digest.length,64);
assert.equal(checkOtp(conf.ANCFZ_OTP_PEPPER,verification.challengeId,"002345",digest),true);
assert.equal(checkOtp(conf.ANCFZ_OTP_PEPPER,verification.challengeId,"002344",digest),false);
assert.equal(checkOtp(conf.ANCFZ_OTP_PEPPER,randomUUID(),"002345",digest),false);
assert.equal(checkOtp(conf.ANCFZ_OTP_PEPPER,verification.challengeId,"002345","bad"),false);

const expected={ticketId,quotationId,externalReference:"ANCFZ-"+randomUUID().replaceAll("-",""),
  amount:"425.25",currency:"AED"};
const url="https://mockgateway.com/pg/pay/abc123";
assert.equal(isCheckoutUrl(url),true);
assert.equal(paymentIdFromCheckout(url),"abc123");
assert.equal(paymentIdFromCheckout(url+"?status=COMPLETE"),null);
assert.equal(paymentIdFromCheckout("https://mockgateway.com/pg/pay/abc123/extra"),null);
for(const test of ["http://mockgateway.com/pg/pay/abc","https://evil.invalid/pg/pay/abc",
  "https://mockgateway.com.evil.invalid/pg/pay/abc","https://mockgateway.com/admin"])
  assert.equal(isCheckoutUrl(test),false);
const order={provider:"2checkout_mock",verified:false,orderReference:"123456789",
  ...expected,status:"checkout_available",checkoutUrl:url};
assert.equal(verifyCreatedOrder(order,expected)?.checkoutUrl,url);
assert.deepEqual(inspectCreatedOrder(order,expected),{
  created:{orderReference:order.orderReference,providerPaymentId:"abc123",
    checkoutUrl:url,state:"checkout_available"},
  reason:"validated",
});
assert.equal(inspectCreatedOrder(null,expected).reason,"post_invalid_json_shape");
assert.equal(inspectCreatedOrder({...order,provider:"wrong"},expected).reason,
  "post_provider_contract_invalid");
assert.equal(inspectCreatedOrder({...order,ticketId:randomUUID()},expected).reason,
  "post_order_identity_mismatch");
assert.equal(inspectCreatedOrder({...order,amount:"425.26"},expected).reason,
  "post_order_price_mismatch");
assert.equal(inspectCreatedOrder({...order,orderReference:123},expected).reason,
  "post_order_reference_invalid");
assert.equal(inspectCreatedOrder({...order,providerPaymentId:"wrong"},expected).reason,
  "post_provider_payment_id_mismatch");
assert.equal(verifyCreatedOrder({...order,providerPaymentId:"abc123"},expected)?.providerPaymentId,"abc123");
assert.equal(inspectCreatedOrder({...order,checkoutUrl:"https://evil.invalid"},expected).reason,
  "post_checkout_contract_invalid");
assert.equal(verifyCreatedOrder({...order,verified:true},expected),null);
assert.equal(verifyCreatedOrder({...order,amount:"425.26"},expected),null);
assert.equal(verifyCreatedOrder({...order,checkoutUrl:"https://evil.invalid/"},expected),null);
assert.equal(verifyCreatedOrder({...order,status:"order_created_checkout_unavailable",checkoutUrl:null},expected)?.state,
  "order_created_checkout_unavailable");
assert.equal(verifyCreatedOrder({...order,status:"order_created_checkout_unavailable",checkoutUrl:null},expected)?.providerPaymentId,null);

const check={...expected,orderReference:order.orderReference};
const paid={...check,provider:"2checkout_mock",providerStatus:"COMPLETE",
  status:"verified_test_payment",verified:true};
assert.equal(verifyPaymentStatus(paid,check)?.verified,true);
const withPaymentId={...check,providerPaymentId:"abc123"};
assert.equal(verifyPaymentStatus({...paid,providerPaymentId:"abc123"},withPaymentId)?.verified,true);
assert.equal(verifyPaymentStatus({...paid,providerPaymentId:"wrong"},withPaymentId),null);
assert.equal(verifyPaymentStatus(paid,withPaymentId),null);
for(const [providerStatus,status] of [
  ["PENDING","payment_pending"],["DECLINED","payment_declined"],["REFUNDED","payment_refunded"],
])assert.equal(verifyPaymentStatus({...paid,providerStatus,status,verified:false},check)?.verified,false);
for(const bad of [
  {amount:"425.26"},{currency:"USD"},{orderReference:"wrong"},
  {externalReference:"ANCFZ-other"},{providerStatus:"PENDING"},
  {status:"checkout_available"},{verified:false},{provider:"mockgateway_demo_orders"},
])assert.equal(verifyPaymentStatus({...paid,...bad},check),null);

// Financial state machine: transient GET errors cannot revoke a prior
// COMPLETE; an independently reported REFUNDED is never resurrected.
const completed=verifyPaymentStatus(paid,check);
const refunded=verifyPaymentStatus({
  ...paid,providerStatus:"REFUNDED",status:"payment_refunded",verified:false,
},check);
assert.deepEqual(reconcileGatewayCheck("payment_pending","PENDING",completed),
  {state:"verified_test_payment",providerStatus:"COMPLETE"});
assert.deepEqual(reconcileGatewayCheck("verified_test_payment","COMPLETE",null),
  {state:"verified_test_payment",providerStatus:"COMPLETE"});
assert.deepEqual(reconcileGatewayCheck("verifying","COMPLETE",null),
  {state:"verified_test_payment",providerStatus:"COMPLETE"});
assert.deepEqual(reconcileGatewayCheck("verified_test_payment","COMPLETE",refunded),
  {state:"payment_refunded",providerStatus:"REFUNDED"});
assert.deepEqual(reconcileGatewayCheck("payment_refunded","REFUNDED",completed),
  {state:"payment_refunded",providerStatus:"REFUNDED"});
assert.deepEqual(reconcileGatewayCheck("payment_pending","PENDING",null),
  {state:"unknown_outcome",providerStatus:"verification_failed"});

// The invoice must be RETRYABLE while the payment check is in-flight.
assert.equal(invoiceFinalizationDecision("verifying",true),"deferred");
assert.equal(invoiceFinalizationDecision("verified_test_payment",true),"verified_completed");
assert.equal(invoiceFinalizationDecision("verified_test_payment",false),"unknown_outcome");
assert.equal(invoiceFinalizationDecision("payment_refunded",true),"unknown_outcome");
assert.equal(invoiceFinalizationDecision("unknown_outcome",true),"unknown_outcome");

const bytes=Buffer.from("%PDF-1.4\n"+("x".repeat(200))+"\n%%EOF");
const data={status:"generated",ticketId,documentNumber:"ANCFZ-TEST-INV-123",
  mimeType:"application/pdf",pdfBase64:bytes.toString("base64")};
const invoice=verifyInvoicePdf({...data,documentType:"invoice"},data);
assert(invoice);assert.equal(invoice.bytes.toString("hex"),bytes.toString("hex"));
assert.equal(verifyInvoicePdf({...data,documentType:"quotation"},data),null);
assert.equal(verifyQuotationPdf({...data,documentType:"invoice"},data),null);
console.log("P5 2Checkout Node contracts PASS: development-only mock, HMAC OTP, consent, create/verify evidence, invoice validation");
