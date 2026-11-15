# POC flow reliability and recovery

Status: implemented on `fix/poc-flow-reliability`; live provider acceptance is separate. See `AGENTS.md` for the governing contract.

## Invariants

- **Never replay an ambiguous provider-side POST.** Salesforce lead creation and sandbox order creation remain quarantined in `unknown_outcome` until independently verified. Their existing idempotency keys and customer consent are not relaxed.
- **An uncertain Foundry response is not retried automatically.** Once the interrupted turn is marked `uncertain`, new customer turns can proceed from the last *committed* response cursor. Business-function tools exposed to the model only read/record source-linked ticket facts/intents; external lead/payment actions still require the authenticated Node UI.
- **Per-ticket turn ordering stays serialized in PostgreSQL.** The in-process worker allows up to three *different* tickets concurrently; scaling beyond one API process still relies on transactional `TurnQueue.claim`.
- **No provider success is inferred from SSE, a redirect or n8n HTTP 2xx.** PostgreSQL verification state is authoritative. Lifecycle notice writes never authorize an operation.
- **Missing lifecycle notices are repaired read-only** every 30 seconds (verified Salesforce lead, consumed sandbox OTP, verified sandbox payment) with deterministic message IDs. Recovery never contacts n8n or creates new leads/orders. Existing invoice-link recovery remains independent.
- **Document correction occurs before purchase confirmation only.** The replacement re-runs OCR, overwrites the previous synthetic bytes and keeps old/new SHA-256 hashes in agent-scoped `purchase.document.replaced` events. No previous identity bytes are retained.
- **Long tickets remain accessible.** Ticket bootstrap returns the newest 200 messages; `GET /api/v1/tickets/:ticketId/messages?before=<sequence>&limit=100` pages backward. All reads and source lookups authorize the owner and agent, and external citations do not falsely advertise a provider-file download.
- **SSE is primary.** Connected browsers use durable event-driven refresh. While disconnected or reconnecting, the client reconciles status every 10 seconds; the existing PostgreSQL SSE replay loop remains unchanged.

## Forward-only migration

`014_purchase_document_corrections.sql` grants column-limited updates to the existing agent-runtime role and adds `replaced_at`. Do not edit past migration checksums, run `down -v` on retained databases, or expose real identity files over HTTP.

## Acceptance and limitations

The P3 integration smoke covers latest-window and older-message pagination, ticket ownership and synthetic document correction under RLS. A separate offline worker test covers three-slot concurrency and replacement scheduling. P0/P2/P3 smoke gates cover builds and disposable deployment, **not** live Foundry/Salesforce/Azure OCR/2Checkout success.

Remaining provider-specific work:
- Authoritative **read-only** Salesforce/n8n reconciliation for ambiguous lead creation. Until the remote provider supports it, keep these operations in `unknown_outcome`; do not submit the same lead again automatically.
- Provider-side reconciliation for ambiguous sandbox order POSTs; never automatically repeat a merchant POST.
- Live document OCR and merchant refund, delayed invoice, SSE reconnect and browser end-to-end tests.
- Redis-driven SSE wakeups, multi-instance load testing and dedicated performance baselines can be addressed after live POC acceptance.
