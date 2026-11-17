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

// New assistant messages may arrive through SSE or catch-up refresh. Both
// trigger focus once; loading historical replies and older pages must not.
assert.match(chat,/seenAssistantMessages\.current = new Set\(/);
assert.match(chat,/if \(novelReplies\.length\) setFocusReplyId\(/);
assert.match(chat,/if \(!seenAssistantMessages\.current\.has\(incomingMessage\.id\)\)/);
assert.match(chat,/focusReplyId=\{focusReplyId\}/);
// Frontend-only buttons must send the existing exact chat consent text,
 // not invent a new backend operation or expose approvals on stale messages.
const consentSource=readFileSync("apps/web/lib/chat-consent.ts","utf8");
const consentExports={};
new Function("exports",ts.transpileModule(consentSource,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText)(consentExports);
const quoteConsent=consentExports.QUOTATION_CONSENT_TEXT;
const purchaseConsent=consentExports.PURCHASE_CONSENT_TEXT;
const proposalRef="11111111-1111-4111-8111-111111111111";
const quoteProposal={
  id:"quote-proposal",role:"assistant",
  text:"**Review your ANCFZ enquiry and quotation**\\n"+
    "Proposal reference: "+proposalRef+"\\n"+
    'To approve both actions, reply: "'+quoteConsent+'"',
};
const purchaseProposal={
  id:"purchase-proposal",role:"assistant",
  text:"**Review your sandbox purchase and test payment**\\n"+
    "Proposal reference: "+proposalRef+"\\n"+
    'To approve, reply: "'+purchaseConsent+'"',
};
const customer={id:"customer-reply",role:"customer",text:"No, I need changes"};
const notice={id:"notice",role:"assistant",text:"Your existing ticket is saved."};
const pending=consentExports.pendingChatConsent;
assert.deepEqual(pending([quoteProposal]),{
  messageId:quoteProposal.id,kind:"quotation",text:quoteConsent,
});
assert.deepEqual(pending([purchaseProposal]),{
  messageId:purchaseProposal.id,kind:"purchase",text:purchaseConsent,
});
assert.deepEqual(pending([quoteProposal,notice]),{
  messageId:quoteProposal.id,kind:"quotation",text:quoteConsent,
},"A lifecycle notice must not cancel exact scoped approval");
assert.deepEqual(pending([quoteProposal,purchaseProposal]),{
  messageId:purchaseProposal.id,kind:"purchase",text:purchaseConsent,
},"Only the newest proposal can have an active button");
assert.equal(pending([quoteProposal,customer]),null);
assert.equal(pending([purchaseProposal,{...customer,text:purchaseConsent}]),null);
assert.equal(pending([{...quoteProposal,text:quoteProposal.text.replace(quoteConsent,"yes")}]),null);
assert.equal(pending([{...purchaseProposal,text:"Your invoice is ready"}]),null);
assert.equal(pending([{...quoteProposal,text:quoteProposal.text.replace(proposalRef,"not-a-reference")}]),null);
assert.equal(pending([{...quoteProposal,role:"customer"}]),null);
assert.match(chat,/pendingChatConsent\\(messages\\)/);
assert.match(chat,/consentText=\\{pendingConsent\\?\\.messageId===message\\.id/);
assert.match(chat,/consentDisabled=\\{locked\\|\\|isSending\\}/);
assert.match(chat,/onConsent=\\{send\\}/);
const bubble=readFileSync("apps/web/components/chat-message.tsx","utf8");
assert.match(bubble,/I Consent/);
assert.match(bubble,/disabled=\\{consentDisabled\\|\\|submittingConsent\\}/);
assert.match(bubble,/await onConsent\\(consentText\\)/);
assert.doesNotMatch(bubble,/chat-journey\\/approve|lead\\/submit/,
  "Consent button is a chat message, not a direct side-effect API");
console.log("Chat I Consent PASS: exact quote/purchase text, current proposal only, safe one-click send");

const composer=readFileSync("apps/web/components/chat-composer.tsx","utf8");
assert.match(composer,/if \(!focusReplyId \|\| disabled \|\| sending/);
assert.match(composer,/handledReplyId\.current === focusReplyId/);
assert.match(composer,/document\.visibilityState !== "visible"/);
assert.match(composer,/Secure in-chat journey/);
assert.match(composer,/textarea\.focus\(\{ preventScroll: true \}\)/);
console.log("Chat focus PASS: one focus per new reply, locked-turn deferral, secure-input protection");
console.log("Chat-only layout PASS: legacy action panel absent, transcript and SSE preserved");


// The exact chat consent must not be inferred from a generic "yes",
// unrelated customer conversation, or a mismatched purchase approval.
const {
  isLeadQuoteApproval,isPurchasePaymentApproval,
  LEAD_QUOTE_APPROVAL,PURCHASE_PAYMENT_APPROVAL,isContextualApproval,
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
assert.equal(isContextualApproval("yes"),true);
assert.equal(isContextualApproval("go ahead"),true);
assert.equal(isContextualApproval("i approve"),true);
assert.equal(isContextualApproval("yes, but change to 0 visas"),false);
assert.equal(isContextualApproval("not yet"),false);
const inline=readFileSync("apps/web/components/chat-journey-controls.tsx","utf8");
assert.ok(chat.includes("<ChatJourneyControls"),"Secure chat controls must mount in transcript");
assert.match(inline,/chat-journey\/otp\/verify/);
assert.match(inline,/purchase\/documents/);
assert.match(inline,/autoComplete="one-time-code"/);
assert.match(inline,/\.size>1048576/);
assert.doesNotMatch(inline,/payments\/otp/,"Only Node automatically starts OTP after chat consent");
assert.match(inline,/payments\/"\+encodeURIComponent\(payment.id\)\+"\/checkout-link"/,
  "Existing orders must reopen through a ticket-scoped backend check");
assert.match(inline,/payments\/"\+encodeURIComponent\(paymentId\)\+"\/checkout-closed"/,
  "Closing the mini checkout window must trigger independent verification");
assert.match(inline,/window\.open\("about:blank"/,
  "Mini-window must be opened synchronously from a customer gesture");
assert.match(inline,/if\(!popup\.closed\)return;/,
  "Only a closed popup triggers the post-checkout status check");
assert.match(inline,/result\.newOrderCreated!==false/,
  "The UI must reject unexpected order creation in link regeneration");
const ticketEvents=readFileSync("apps/web/hooks/use-ticket-events.ts","utf8");
assert.match(ticketEvents,/"payment\.checkout_link_reopened"/);
assert.match(ticketEvents,/"payment\.checkout_closed_checked"/);

console.log("Chat consent contracts PASS: exact/contextual approval, immutable snapshot, secure in-chat inputs");

await import("./check-chat-journey-state.mjs");
await import("./check-chat-consent-reconciliation.mjs");
await import("./check-dev-synthetic-passport.mjs");
