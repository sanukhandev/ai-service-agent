import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {isExplicitPaymentRetryRequest} from "../services/api/dist/runtime/payment-operations.js";
import {PURCHASE_PAYMENT_APPROVAL} from "../services/api/dist/runtime/chat-journey.js";

const source=(p)=>readFileSync(p,"utf8");
for(const text of [
  "retry my payment","retry declined payment","please retry the payment",
  "try my payment again","resend payment otp","send me a fresh payment otp",
  "generate new payment link","create a fresh payment link",
]){
  assert.equal(isExplicitPaymentRetryRequest(text),true,"Explicit retry request: "+text);
}
for(const text of [
  "yes","continue","retry","I would like to start a company",
  "check payment status","this is my Emirates ID","retry Salesforce lead",
  "retry every charge automatically","resend quote OTP",
]){
  assert.equal(isExplicitPaymentRetryRequest(text),false,"Unintended payment retry: "+text);
}

const pay=source("services/api/src/runtime/payment-operations.ts");
const sql=source("infra/postgres/017_declined_payment_retry.sql");
const contracts=source("services/api/src/runtime/service-contract-worker.ts");
const contractSql=source("infra/postgres/018_test_service_contracts.sql");
const web=source("apps/web/components/chat-journey-controls.tsx");
const consent=source("apps/web/lib/chat-consent.ts");
const migration=source("infra/bootstrap/apply-migrations.sh");
const turn=source("services/api/src/runtime/turn-worker.ts");

assert.match(pay,/previous\.provider_status!=="DECLINED"/);
assert.match(pay,/lastPayment\.provider_status!=="DECLINED"/);
assert.match(pay,/"2checkout-create:"\+attemptId/);
assert.match(pay,/retry_of_payment_id/);
assert.match(pay,/payment\.retry_queued/);
assert.match(pay,/replace(d)?; verify the new payment/);
assert.match(sql,/WHERE state <> 'payment_declined'/);
assert.match(sql,/retry_of_payment_id/);
assert.ok(migration.indexOf("016_quotation_confirmation_otp.sql") <
  migration.indexOf("017_declined_payment_retry.sql"));
assert.ok(migration.indexOf("017_declined_payment_retry.sql") <
  migration.indexOf("018_test_service_contracts.sql"));

assert.match(turn,/isExplicitPaymentRetryRequest\(text\)/);
assert.match(turn,/renewOtp\(scope,turn\.ticketId/);
assert.match(web,/Retry declined payment — request new OTP/);
assert.match(web,/payments\/otp\/renew/);
assert.match(consent,/private nonbinding TEST service contract/);
assert.ok(consent.includes(PURCHASE_PAYMENT_APPROVAL));

assert.match(pay,/consentValid/);
assert.match(pay,/currentRenewal\?RENEWAL_PURCHASE_CONSENT:PURCHASE_CONSENT/);
assert.match(pay,/INSERT INTO ticket_service_contracts/);
assert.match(pay,/p\.state='verified_test_payment'/);
assert.match(contracts,/invoiceQuoteDetails\(c\.quotePayload/);
assert.match(contracts,/extractInvoiceEmiratesId\(emirates\.bytes\)/);
assert.match(contracts,/sha\(f\.bytes\)!==f\.sha256/);
assert.match(contracts,/kind==="passport"/);
assert.match(contracts,/kind==="emirates_id"/);
assert.match(contracts,/NOT CRYPTOGRAPHICALLY SIGNED \/ NOT LEGALLY EXECUTED/);
assert.match(contracts,/forms\/pdfengines\/merge/);
assert.match(contracts,/pc\.consent_text=\$4/);
assert.match(contracts,/pc\.consent_text=\$5/);
assert.match(contracts,/agreementNumber/);
assert.match(contracts,/invoiceNumber/);
assert.match(contractSql,/FORCE ROW LEVEL SECURITY/);
assert.match(contractSql,/UNIQUE\(agent_id,ticket_id,payment_id\)/);
assert.match(pay,/async contractPdf\(/);

console.log("Payment retry + demo contract offline guards PASS");
