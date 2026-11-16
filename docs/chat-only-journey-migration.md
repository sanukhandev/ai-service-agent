# Chat-only customer journey transition

Status: **UI removal prepared; do not deploy before conversational authorization is implemented.**

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

## Current gap
The branch removing the old `IntentActionPanel` is **not functionally complete**. The existing lead, quotation, document, purchase, OTP and payment routes remain operational for authorized clients, but the customer UI no longer exposes their older forms. The chat worker currently records intents and facts only and **does not execute authorized side effects from chat consent**.

Do not merge/deploy this UI-only change in isolation. The chat-based action authorization/orchestrator and secure inline controls must land together, with a fresh synthetic end-to-end Lead -> Quote -> Documents -> Purchase consent -> OTP -> Payment verification -> TEST Invoice acceptance test.
