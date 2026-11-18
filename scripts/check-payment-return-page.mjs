#!/usr/bin/env node
/** Static safety checks; Docker smoke also exercises the actual callback route. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const page=readFileSync("apps/web/app/page.tsx","utf8");
const returnPage=readFileSync("apps/web/components/payment-return.tsx","utf8");

assert.match(page,/typeof params\.refno === "string"/);
assert.match(page,/typeof params\.order_status === "string"/);
assert.match(page,/if \(isGatewayReturn\) return <PaymentReturn \/>/);
assert.match(page,/return <CustomerChat agentKey=\{agentKey\} \/>/,
  "Normal root visits must still load Sara");
assert.match(returnPage,/window\.setTimeout\(\(\) => \{/);
assert.match(returnPage,/window\.close\(\)/);
assert.match(returnPage,/\}, 2000\)/);
assert.match(returnPage,/window\.clearTimeout\(timeout\)/);
assert.match(returnPage,/Your payment status is/);
assert.match(returnPage,/verified separately with the gateway/);
assert.match(returnPage,/did not close this tab automatically/);
assert.ok(!/\b(?:setPaymentStatus|verifyPayment|fetch\(|requestJson\()/i.test(returnPage),
  "Gateway redirect must never issue or verify a payment by itself");
assert.ok(!/params\.(?:total|currency|merchant_order_id)\b/.test(page),
  "The public callback params are never authority for amounts or order identity");
console.log("Gateway return page PASS: root callback, two-second popup close, manual fallback, no payment-state mutation");
