# POC flow reliability and recovery

Status: implemented on `fix/poc-flow-reliability`; live provider acceptance is separate. See `AGENTS.md` for the governing contract.

## Invariants

- **Never replay an ambiguous provider-side POST.** Salesforce lead creation and sandbox order creation remain quarantined in `unknown_outcome` until independently verified. Their existing idempotency keys and customer consent are not relaxed.
- **An uncertain Foundry response is not retried automatically.** Once the interrupted turn is marked `uncertain`, new customer turns can proceed from the last *committed* response cursor. Business-function tools exposed to the model only read/record source-linked ticket facts/intents; external lead/payment actions still require the authenticated Node UI.
- **Per-ticket turn ordering stays serialized in PostgreSQL.** The in-process worker defaults to **one active turn** (`FOUNDRY_TURN_CONCURRENCY=1`; optional 1–3) while burst throttling is investigated. Per-ticket ordering still relies on transactional `TurnQueue.claim`. A multi-process deployment needs distributed quota coordination.
- **No provider success is inferred from SSE, a redirect or n8n HTTP 2xx.** PostgreSQL verification state is authoritative. Lifecycle notice writes never authorize an operation.
- **Missing lifecycle notices are repaired read-only** every 30 seconds (verified Salesforce lead, consumed sandbox OTP, verified sandbox payment) with deterministic message IDs. Recovery never contacts n8n or creates new leads/orders. Existing invoice-link recovery remains independent.
- **Document correction occurs before purchase confirmation only.** The replacement re-runs OCR, overwrites the previous synthetic bytes and keeps old/new SHA-256 hashes in agent-scoped `purchase.document.replaced` events. No previous identity bytes are retained.
- **Long tickets remain accessible.** Ticket bootstrap returns the newest 200 messages; `GET /api/v1/tickets/:ticketId/messages?before=<sequence>&limit=100` pages backward. All reads and source lookups authorize the owner and agent, and external citations do not falsely advertise a provider-file download.
- **SSE is primary.** Connected browsers use durable event-driven refresh. While disconnected or reconnecting, the client reconciles status every 10 seconds; the existing PostgreSQL SSE replay loop remains unchanged.

## Forward-only migration

`014_purchase_document_corrections.sql` grants column-limited updates to the existing agent-runtime role and adds `replaced_at`. Do not edit past migration checksums, run `down -v` on retained databases, or expose real identity files over HTTP.

## Acceptance and limitations

The P3 integration smoke covers latest-window and older-message pagination, ticket ownership and synthetic document correction under RLS. Offline regression tests cover single-turn throttling, confirmed 429-only retry, header parsing, bounded retry delays, and safe function continuation without rerunning application tools. P0/P2/P3 smoke gates cover builds and disposable deployment, **not** live Foundry/Salesforce/Azure OCR/2Checkout success.

Remaining provider-specific work:
- Authoritative **read-only** Salesforce/n8n reconciliation for ambiguous lead creation. Until the remote provider supports it, keep these operations in `unknown_outcome`; do not submit the same lead again automatically.
- Provider-side reconciliation for ambiguous sandbox order POSTs; never automatically repeat a merchant POST.
- Live document OCR and merchant refund, delayed invoice, SSE reconnect and browser end-to-end tests.
- Redis-driven SSE wakeups, multi-instance load testing and dedicated performance baselines can be addressed after live POC acceptance.

## Foundry rate-limit mitigation and token budget (November 2026)

- Sara remains on the existing pinned GPT-5.4 Foundry agent with native IQ. Do not automatically publish a new agent version or fail over to the severely constrained GPT-5-mini deployment.
- Azure Monitor found four 429 responses in 50 requests. The observed rate is consistent with burst throttling despite the configured 125k TPM quota; it does not prove hourly quota exhaustion.
- The SDK still has **zero implicit retries**. Only a provider call definitively rejected with HTTP **429** gets up to **three total attempts**. Initial requests and the exact `function_call_output` continuation are retried at their own boundary. Executed Node tools are never invoked again as part of recovery; unknown timeout/network/5xx outcomes are not retried.
- The in-process request gate spaces calls by 1.5 seconds and follows `retry-after-ms`, `Retry-After` and recognized remaining/reset headers when available. All waits fit the existing 60-second turn deadline. Cross-instance quotas are not coordinated; production requires Redis/distributed pacing.
- Each Foundry HTTP attempt logs phase, status, latency, request ID if provided, allowed rate-limit headers, and retry delay. Successful turns log aggregate input/output/reasoning/cached tokens, provider-call and tool-round counts, total runtime and prompt payload bytes. Missing headers or unavailable token metrics remain absent, not fabricated.
- Catalog readiness loads required facts and requirement definitions once per lookup instead of repeating the same fact query for each action. Current Node-per-turn instruction text is shortened without relaxing explicit consent or secure-document rules.
- The published agent instructions and IQ settings are managed by versioned Foundry publication. Do not hardcode `max_output_tokens=800` into all Responses requests: GPT reasoning consumes part of the output budget and some agent modes restrict request overrides. Test low reasoning effort/concise answers on a **new agent version** against the full quote–payment–invoice journey before publication.

To validate locally after pulling the branch, run `npm install --no-audit --no-fund && npm run build`, then `node scripts/check-foundry-rate-control.mjs` and `node scripts/check-turn-worker-concurrency.mjs`. Live provider acceptance still requires an authenticated GPT-5.4 Foundry call; offline CI does not establish it.
