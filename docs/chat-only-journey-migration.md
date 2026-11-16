# Chat-only customer journey transition

Status: **Chat-first Node authorization, safe inline synthetic documents/OTP, and backend journey sequencing implemented on draft PR #30. Code-level smoke tests run in CI; live Foundry/Salesforce/n8n/2Checkout end-to-end acceptance is still required before deployment.**

## Target interaction
- The chat transcript and composer are the only persistent customer-facing layout. Do not render the separate `Available actions for <intent>` panel.
- Sara collects and corrects customer-stated facts in the conversation. Exact package selection comes from the ticket-pinned offering catalog (visa count, term, office requirements); never default to the first option.
- A transaction-specific, explicit conversational authorization covers **Salesforce contact-sharing and generation of the selected nonbinding quotation**. Record the exact reviewed contact fields, offering key, price revision, amount and terms with the consent message ID before any effect.
- Node durably queues the Salesforce lead. After a *verified* Lead ID, Node automatically queues the matching quotation. Unknown provider outcomes stop advancement; no automatic POST replay.
- Verified quotation results and PDF links are surfaced as owner-scoped chat milestones, not automatically inferred from HTTP 200 or model text.
- Identity uploads can be **inline secure chat controls** but uploaded document bytes, names and extracted identity fields must stay outside Foundry prompts and public transcript messages.
- A **second**, exact-amount purchase consent is required before synthetic OTP. OTP entry is an isolated secure control (never a text message); card information stays at hosted checkout.
- Only independently verified sandbox payment permits TEST invoice generation, download link and chat milestone. Do not claim paid status from checkout redirect or n8n response.
- Preserve ticket ownership, SSE/replay, idempotency, and restart recovery.

## Backend implementation (draft PR #30)
- `ChatJourney.prepare` reads source-linked ANCFZ ticket facts and matches the **exact** visa-count/term SKU and price revision; missing details are asked in chat instead of defaulting to the first SKU. Office preference is disclosed as a request, not falsely guaranteed in the package.
- Customer authorization is an **exact conversational approval** immediately following the displayed Node-generated proposal, with proposal reference and frozen snapshot. Node commits the approval locally; Foundry does not execute the action.
- `ChatJourneyDispatcher` scans durable consent events and calls existing idempotent `LeadOperations.submit`; only a verified Lead ID permits matching `QuotationOperations.submit`. Reconciled/unknown outcomes are never blindly retried.
- The second exact-amount purchase/payment authorization is separate. Validated synthetic document intake remains behind `PurchaseOperations`. After consent, Node records purchase confirmation, requests one synthetic OTP and writes a dispatch-start marker before the n8n POST to prevent crash replays.
- `GET /api/v1/tickets/:ticketId/chat-journey` gives the ticket owner document readiness, OTP challenge ID (never the code), payment and invoice state for inline chat controls. `POST /api/v1/tickets/:ticketId/chat-journey/otp/verify` securely accepts only challenge ID, 6-digit code and idempotent request ID. The OTP must never be sent through `/messages` or Foundry.
- Existing purchase document upload APIs, independent 2Checkout GET verification, and verified TEST invoice PDF endpoint remain authoritative. Verified quote and hosted-checkout links are delivered as ticket-scoped lifecycle messages.

## Rollout blockers
The Next.js transcript now contains `ChatJourneyControls`: secure synthetic PDF/PNG/JPEG attachment upload (1 MiB maximum), private six-digit OTP verification, quotation and invoice download, and an allowlisted hosted sandbox checkout link. The old `Available actions` panel is removed. These are secure controls **inside the conversation viewport**; never paste identity bytes, OTPs, or card data into the message composer. Hosted sandbox checkout remains an external site.

Natural short assent such as `yes` is accepted **only** immediately after a server-generated exact proposal appears as the latest assistant message on that ticket. All actual money/price/lead operations remain on Node with mandatory provider verification. The lead/quote dispatcher now enforces full catalog fact readiness and checks the exact consented quote price revision inside the final submission transaction.

Run a fresh synthetic Lead -> Quote -> identity upload -> purchase consent -> OTP -> hosted checkout -> verified payment -> TEST invoice smoke with deployed Foundry, n8n, Salesforce sandbox, OCR and 2Checkout mocks before declaring provider success. Offline CI also executes `scripts/check-chat-journey-state.mjs` for one-shot lead/quote/OTP, unknown-outcome quarantine and replay prevention, but cannot verify live credential, network or merchant behavior. Do not merge before the fresh end-to-end acceptance is captured. Keep the older unknown-outcome Salesforce ticket quarantined.

### Consent phrases
- Salesforce + quotation: `I authorize ANCFZ to send my contact details to Salesforce and prepare the non-binding quotation shown.`
- Sandbox purchase + OTP preparation: `I authorize the ANCFZ sandbox purchase and test payment for the exact quotation amount shown.`

Exact phrases always require the immediately preceding matching ticket-scoped proposal. Short acknowledgments such as `yes`, `go ahead`, or `I approve` also work **only** when the immediately preceding assistant response displays that specific Node-generated proposal and its full scope. A free-floating `yes` never authorizes an operation.
