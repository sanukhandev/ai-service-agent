# P5 Gemini / n8n business bridge (G0 8078e46e)

Status: **offline adapter implemented; integration wiring and provider E2E remain pending**. This is a model-independent Node component. It does not expose any Gemini tool that performs business side effects.

## Supported durable integration

`GeminiN8nBridge.dispatch(serverIssuedScope)` obtains **only** a PostgreSQL operation already queued by Node's existing approved lead/quotation endpoints. `PostgresOperationStore.claim()` uses agent-scoped RLS, locks the joined `ticket_operations` + `event_outbox` rows, rejects missing consent, verifies lead digest and pinned intent or quotation pricing/verified-lead dependency, then atomically leases the outbox and marks it running. The bridge verifies the live, authenticated n8n owner API inventory before sending a request to its fixed private webhook. It parses bounded responses, checks operation-specific evidence, and atomically records an outcome, PDF (when applicable) and ticket event. Redis and AI sessions are not part of this operation's authorization lifetime.

**Integration-owner wiring required:** instantiate the database-backed store and inventory with *private* `N8N_API_KEY` / `ANCFZ_N8N_WEBHOOK_SECRET`, then run dispatch **only from a backend worker obtaining internal operation scope from an authorized database queue**. Run `quarantine(agentId)` on worker startup and periodically for expired leases. Never publish this method as a model or public HTTP endpoint. The existing ANCFZ legacy lead/quotation workers must be retired or mutually excluded when enabling this bridge, otherwise they can compete for the same outbox. Keep the same SQL schema/state and ticket event sequence.

### Workflow inventory (exported state on G0 SHA; not live status)

| Export | Fixed internal POST path | Header Auth | Offline outcome policy |
| --- | --- | --- | --- |
| `00-otp-email.json` | `ancfz/otp-email` | Yes | SMTP acknowledgment, **not** proof of delivery |
| `01-salesforce-lead.json` | `ancfz/salesforce-lead` | Yes | Verified only for correlated `00Q` Salesforce Lead ID |
| `02-render-pdf.json` | `ancfz/render-pdf` | Yes | Verified only for correlated valid bounded PDF and persisted authoritative quotation |
| `03-mockgateway-payment-link.json` | `ancfz/payment-link` | Yes | Demo order/checkout link is **not payment evidence** |
| `04-mockgateway-payment-verify.json` | `ancfz/payment-verify` | Yes | Stub returns `verification_unconfigured`; fail closed |
| `05-mock-otp-table.json` (optional) | `ancfz/otp-email` | Yes | Local-only; requires explicit development opt-in, synthetic address |
| `06-mock-otp-prune.json` (optional) | No webhook (schedule) | N/A | Local-only; must be deliberately activated for cleanup |

All seven JSON templates are `active:false` in the committed G0 exports. This does not establish current runtime activation. The live inventory checker reads n8n's private management API and validates exact matching webhook paths, POST method, Header Auth and **one** active workflow of the requested type. Both original and mock OTP active simultaneously blocks dispatch. Baseline workflow import is expected to be inactive by default.

### Authorization matrix

| Operation | Existing Node preflight / persisted authority | Dispatch now? | Completion proof |
| --- | --- | --- | --- |
| `ancfz_salesforce_lead` | Customer form consent, ticket owner, active pinned `create_lead` intent, field digest, idempotent outbox | Yes, if enabled/active | Correlated Salesforce Lead ID; provider E2E not certified |
| `ancfz_render_quote` | Customer quotation acknowledgment, verified Salesforce Lead, published pinned offering/price snapshot, outbox | Yes, if enabled/active | Correlated PDF bytes, validated checksum and ticket-private storage |
| `ancfz_otp_email` | Requires Node-issued hashed OTP challenge with test-only isolation | **Blocked** pending durable challenge operation contract | SMTP ack is not customer delivery; Node verifies code |
| `ancfz_payment_link` | Requires verified one-use OTP, exact quotation revision, amount and consent | **Blocked** pending durable approval/outbox schema | Demo order ref, not payment success |
| `ancfz_payment_verify` | Requires stored gateway order ref and independent authenticated status query | **Blocked** pending actual provider status API | Current workflow deliberately never verifies payment |

The PostgreSQL 007/008 tables allow only `ancfz_salesforce_lead` and `ancfz_render_quote` keys. The adapter defines strict request/response contracts for all five paths but the persistence store **refuses to claim** the other three; never bypass this with fabricated rows or runtime flags. Proposed/awaiting_authorization/authorized belong to the **existing Node customer approval flow**, not a new P5 state engine. `ticket_operations` has queued/running/verified_completed/unknown_outcome/terminal_failed, while `event_outbox` carries retryable_failed. Retryable pre-dispatch errors are capped at three outbox attempts. Once a network request might have reached n8n, a failure is unknown and not replayed; expiry is quarantined.

### Security and test commands

No caller-provided URL, webhook path, credentials, ticket ownership, agent identity or provider success flag is used. Fixed internal transport URL is `http://n8n:5678/webhook/<allowlisted-path>`, and the n8n inventory endpoint is private `http://n8n:5678/api/v1/workflows`. Redirects are rejected. Headers and OTP values are never logged by the adapter. Nginx at G0 explicitly returns 404 for `/n8n/webhook`, `/n8n/form`, `/n8n/mcp` paths; actual ingress/network validation remains a live deployment gate.

Run offline (Node 22 or later):

```sh
node --experimental-transform-types --test services/api/src/integrations/gemini-n8n/adapter.test.mjs
```

**Remaining external checks:** n8n isolated Compose environment and owner API key, imported/active workflow state, SMTP, Salesforce sandbox Apex ID/correlation, Gotenberg PDF, provider-side duplicate handling, MockGateway order response and documented payment status API, durable payment approval/OTP migrations, authenticated callback/reconciliation route, integration with the Node worker and exact-head PostgreSQL integration tests. Static source review alone does not verify the Compose runtime or provider APIs.

**Integration-owner shared-runtime change request:** choose this adapter as the single worker for lead and quote, wire server-issued operation scopes and client approval endpoints, add durable payment/OTP operation contracts/migrations in P2 ownership, define authoritative provider status reconciliation and callback authentication, and run isolated Docker E2E. This P5 branch deliberately does not change `main`, the experiment branch, shared contracts, Compose, Nginx or existing n8n assets.
