#!/usr/bin/env node
/** Offline regression for duplicated Salesforce buttons and composer overlap.
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
const panelPosition=chat.indexOf("<IntentActionPanel");
const transcriptEnd=chat.indexOf("</section>",transcriptStart);
const footerStart=chat.indexOf("<footer");
assert.ok(transcriptStart>=0 && transcriptEnd>transcriptStart);
assert.ok(panelPosition>transcriptStart && panelPosition<transcriptEnd,
  "Action controls must scroll in the transcript, never expand the fixed composer footer");
assert.ok(footerStart>transcriptEnd);
assert.equal((chat.match(/<IntentActionPanel\b/g)??[]).length,1,
  "Only one action panel may be mounted for a ticket");
console.log("Chat action UI PASS: deduplicated catalog actions and scrollable panel outside composer");
