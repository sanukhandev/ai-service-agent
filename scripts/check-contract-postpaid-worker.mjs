#!/usr/bin/env node
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {contractPostPaymentEnabled} from "../services/api/dist/runtime/service-contract-worker.js";
import {paymentEnabled} from "../services/api/dist/runtime/payment-evidence.js";

// A paid and invoiced agreement remains renderable after payment/OTP
// dispatch is disabled. No new orders are created by the contract worker.
const noDispatch={
  APP_ENV:"development",
  ANCFZ_PAYMENT_DISPATCH_ENABLED:"false",
  ANCFZ_TEST_OTP_ENABLED:"false",
  ANCFZ_OTP_MOCK_ENABLED:"false",
  ANCFZ_N8N_WEBHOOK_SECRET:"",
  ANCFZ_OTP_PEPPER:"",
};
assert.equal(paymentEnabled(noDispatch),false);
assert.equal(contractPostPaymentEnabled(noDispatch),true);
assert.equal(contractPostPaymentEnabled({...noDispatch,ANCFZ_CONTRACT_RENDER_ENABLED:"false"}),false);
assert.equal(contractPostPaymentEnabled({...noDispatch,APP_ENV:"production"}),false);
assert.equal(contractPostPaymentEnabled({...noDispatch,APP_ENV:"test"}),false);
assert.equal(contractPostPaymentEnabled({...noDispatch,APP_ENV:"development",
  ANCFZ_CONTRACT_RENDER_ENABLED:"true"}),true);

const worker=readFileSync("services/api/src/runtime/service-contract-worker.ts","utf8");
assert.match(worker,/contractPostPaymentEnabled\(\)/);
assert.doesNotMatch(worker,/paymentEnabled\(\)/);
assert.match(worker,/ANCFZ postpaid contract rendering enabled/);
assert.match(worker,/ANCFZ postpaid contract rendering disabled/);
assert.match(worker,/p\.state='verified_test_payment'/);
assert.match(worker,/i\.state='verified_completed'/);
assert.match(worker,/pc\.consent_text=\$2/);
assert.match(worker,/AND c\.bytes IS NULL/);
assert.ok(worker.includes("r.status<>'requested' OR NOT EXISTS"));
assert.ok(worker.includes("later.agreement_revision>r.source_revision"));
console.log("Contract post-payment worker PASS: sandbox-only recovery independent of new payments, no financial replay");
