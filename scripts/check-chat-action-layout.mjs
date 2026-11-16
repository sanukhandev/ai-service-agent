#!/usr/bin/env node
/** Offline regression for customer-chat-only layout and legacy action contracts.
 * Requires npm install + API build; no browser or Foundry credentials.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { uniqueAllowedActions } from "../services/api/dist/runtime/intent-action-operations.js";

const repeated=["create_lead","create_lead","generate_quote","create_lead","create_support_request"];
assert.deepEqual(uniqueAllowedActions(repeated),[
  "create_lead","generate_quote","create_support_request",
]);
assert.deepEqual(repeated,["create_lead","create_lead","generate_quote","create_lead","create_support_request"],
  "Catalog normalization must not mutate the published configuration");

const helperSource=readFileSync("apps/web/lib/unique-actions.ts","utf8");
const compiled=ts.transpileModule(helperSource,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText;
const exported={};
new Function("exports",compiled)(exported);
const actions=[
  {actionKey:"create_lead",kind:"salesforce_lead"},
  {actionKey:"create_lead",kind:"salesforce_lead"},
  {actionKey:"generate_quote",kind:"quotation"},
  {actionKey:"create_support_request",kind:"ticket_request"},
  {actionKey:"create_lead",kind:"salesforce_lead"},
];
assert.deepEqual(exported.uniqueActionsByKey(actions).map(a=>a.actionKey),[
  "create_lead","generate_quote","create_support_request",
]);
assert.equal(actions.length,5,"UI normalization must not mutate the source array");

const panel=readFileSync("apps/web/components/intent-action-panel.tsx","utf8");
assert.match(panel,/uniqueActionsByKey\(catalog\.actions\)/);
assert.doesNotMatch(panel,/<PurchaseChecklist\\b/,
  "Intent selection must never render the identity-document intake");

// Sandbox uploads are offered only after a completed quote, and via one
// explicit customer action rather than an automatically expanded card.
const visibilitySource=readFileSync("apps/web/lib/purchase-checkout-visibility.ts","utf8");
const visibilityExports={};
new Function("exports",ts.transpileModule(visibilitySource,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText)(visibilityExports);
for (const quoteReady of [false,true]){
  for (const purchaseSupported of [false,true]){
    for (const sandboxEnabled of [false,true]){
      assert.equal(
        visibilityExports.canStartSandboxCheckout(quoteReady,purchaseSupported,sandboxEnabled),
        quoteReady&&purchaseSupported&&sandboxEnabled,
      );
    }
  }
}
const paymentUI=readFileSync("apps/web/components/payment-checkout.tsx","utf8");
assert.match(paymentUI,/canStartSandboxCheckout\(quoteReady,purchaseSupported,summary\?\.enabled===true\)/);
assert.match(paymentUI,/if\(!payment && !canStartCheckout\)return null/);
assert.match(paymentUI,/if\(!payment && !checkoutOpen\)return <button/);
assert.match(paymentUI,/setCheckoutOpen\(true\)/);
assert.match(paymentUI,/<PurchaseChecklist\b/);
assert.match(paymentUI,/setPurchaseReady\(purchase\?\.readyForOtp===true/,
  "On reload, readiness must restore without a mounted document checklist");
const chat=readFileSync("apps/web/components/customer-chat.tsx","utf8");
const transcriptStart=chat.indexOf("ref={transcriptRef}");
const transcriptEnd=chat.indexOf("</section>",transcriptStart);
const footerStart=chat.indexOf("<footer");
assert.ok(transcriptStart>=0 && transcriptEnd>transcriptStart);
assert.ok(footerStart>transcriptEnd,
  "Chat composer must remain outside the scrollable message transcript");
assert.ok(!chat.includes('from "./intent-action-panel"'),
  "The legacy action panel must not be imported in the chat-only UI");
assert.ok(!chat.includes("<IntentActionPanel"),
  "No action catalog or status card should render below the conversation");
assert.doesNotMatch(chat,/data-chat-action-panel/,
  "Remove obsolete action panel wrapper");
assert.doesNotMatch(chat,/schedulePanelRefresh|eventRevision/,
  "Remove action-panel-specific refresh state and timers");
assert.ok(chat.includes("useTicketEvents("),
  "Continue receiving verified workflow status events over SSE");
console.log("Chat-only layout PASS: legacy action panel absent, transcript and SSE preserved");


// The exact chat consent must not be inferred from a generic "yes",
// unrelated customer conversation, or a mismatched purchase approval.
const {
  isLeadQuoteApproval,isPurchasePaymentApproval,
  LEAD_QUOTE_APPROVAL,PURCHASE_PAYMENT_APPROVAL,
}=await import("../services/api/dist/runtime/chat-journey.js");
assert.equal(isLeadQuoteApproval(LEAD_QUOTE_APPROVAL),true);
assert.equal(isLeadQuoteApproval("Yes, "+LEAD_QUOTE_APPROVAL),true);
assert.equal(isLeadQuoteApproval("yes"),false);
assert.equal(isLeadQuoteApproval("Please generate a quote"),false);
assert.equal(isLeadQuoteApproval(PURCHASE_PAYMENT_APPROVAL),false);
assert.equal(isPurchasePaymentApproval(PURCHASE_PAYMENT_APPROVAL),true);
assert.equal(isPurchasePaymentApproval("Yes, "+PURCHASE_PAYMENT_APPROVAL),true);
assert.equal(isPurchasePaymentApproval("yes"),false);
assert.equal(isPurchasePaymentApproval(LEAD_QUOTE_APPROVAL),false);

const backend=readFileSync("services/api/src/runtime/chat-journey.ts","utf8");
const turnWorker=readFileSync("services/api/src/runtime/turn-worker.ts","utf8");
const turnQueue=readFileSync("services/api/src/runtime/turn-queue.ts","utf8");
assert.match(backend,/proposalId:p\.id,sourceMessageId/);
assert.match(backend,/fingerprint\(current\)!==item\.proposal\.fingerprint/);
assert.match(backend,/lead\.state!=="verified_completed"/);
assert.match(backend,/matched=options\.options\.find/);
assert.match(backend,/chat\.otp\.dispatch_started/);
assert.match(backend,/verifySecureOtp/);
assert.match(turnWorker,/chatJourney\.accept\(/);
assert.match(turnWorker,/completeLocal\(turn/);
assert.match(turnQueue,/async completeLocal\(/);
console.log("Chat consent contracts PASS: exact scoped approval, snapshot and duplicate safety");
