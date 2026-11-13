# Execution plan — POC first, hardening afterward

**Current phase: P0 (foundation, in progress).** The repository began as a documentation-only clean rebuild. This plan supersedes the earlier approach that combined app development with automated test/CI hardening.

## Delivery policy

- **Complete functional POC capabilities before the dedicated hardening cycle.** No large unit-test, integration-test, browser E2E, performance benchmark or full CI implementation work until H1.
- **Do not confuse avoiding test development with skipping operational validation.** Every phase must still compile/build, boot when applicable, pass basic migration checks and demonstrate a live happy path. External Foundry/n8n success cannot be inferred from code alone.
- Do not remove fundamental security requirements (agent authorization, scoped access, OTP isolation, explicit action approval, secret handling) merely because automated security tests are deferred.
- No LangGraph, pgvector, Tenant entity, old V1/V2 code, alternate conversation engine or unnecessary service scaffolding.
- Commit phase by phase with exact changed files and a truthful statement of what is running, mocked or blocked.

## Phase breakdown

| Phase | Work | Practical exit criteria | Dependencies |
|---|---|---|---|
| **P0 Foundation** | npm monorepo; shared HTTP/tool/SSE contracts; environment example; clean DB baseline; simple Docker Compose and Nginx single-port architecture | New repo has agreed contracts, boots essential local containers and exposes only Nginx port 80 | None |
| **P1 Foundry Gateway** | Python FastAPI; AzureCliCredential with persistent Docker volume; invoke existing published GPT-5.4 Sara agent and its attached Foundry IQ | Real greeting and real package query produce responses and source references, not mock claims | P0; provisioned agent |
| **P2 Customer Conversation** | Fastify Agent/Ticket/Message service; PostgreSQL transactions; Redis context/event cache; SSE replay; minimal Next.js Tailwind chat | Browser can open a ticket, chat with Sara, refresh/resume and see persisted history | P0, P1 |
| **P3 Business Catalog & Tools** | Versioned intents/requirements, offerings/prices, Node tool registry; register read functions on Foundry agent without losing IQ tool | Sara identifies a business goal, retrieves requirements/offering data and asks relevant next question | P2 |
| **P4 Authorized n8n Operations** | Action proposals, customer HTTP approval, outbox dispatch, verified n8n CRM lead and quote templates, idempotency/reconciliation | Customer-approved lead or quote completes with verified provider evidence and ticket updates | P3; workflow template can be drafted earlier |
| **P5 Customer Services** | Agent-scoped accounts, email OTP UI/API, Presidio selective PII, private uploads, Azure Document Intelligence OCR | Customer can verify identity and submit/extract private ticket documents without exposing OTP to model | P2; can develop parallel to P3/P4 |
| **P6 Admin Portal** | Angular + Tailwind static app at /admin/; Agent binding, persona/catalog/offerings/tool grants, workflow config, tickets | Admin can view/edit/configure another Agent with simple forms and tables | P0 + published Node admin API, can build static UI in parallel |
| **P7 POC Integration** | Wire all services; remove placeholder paths; complete Docker route/env/startup integration; manually demonstrate full customer journey | Functional POC: knowledge, tickets, intent, quotes/lead, auth/OTP, docs/OCR and admin work together | P1-P6 |
| **H1 Hardening (after POC)** | Unit/contract/integration/E2E tests, security review, migrations/RLS certification, load benchmarks, CI/release automation, observability tuning | Measured pass/fail gates and production readiness assessment, not an automatic production claim | P7 |

Scope is driven by working user journeys. POC can use local-only HTTP on port 80; customer credentials/PII must not be transmitted on public, unencrypted HTTP.

## Parallel development strategy

**First freeze P0 contracts** in `packages/contracts/`: agent ID and binding, ticket IDs, POST/GET endpoints, event IDs, `POST /internal/turns`, tool function contracts, error/status semantics and internal auth. Shared contracts and Compose have one owner.

After P0, use **five independent tracks**:

| Track | File ownership | Earliest start | Integrates when |
|---|---|---|---|
| A: Foundry | `services/ai-gateway/` | After P0 | P1; then application tools in P3 |
| B: API + DB | `services/api/`, `infra/postgres/` | After P0 | P2; then P3/P4/P5 |
| C: Customer web | `apps/web/` | After API contracts freeze | P2 |
| D: Angular admin | `apps/admin/` | After API contracts freeze | P6 |
| E: n8n workflows | `infra/n8n/` | After action contracts freeze | P4 |

The **integration owner alone** edits `docker-compose.yml`, `infra/nginx/`, shared `packages/contracts/`, root toolchain and cross-service configuration. Avoid parallel commits to the same file. Use isolated branches/worktrees for genuinely simultaneous writers, then merge with one coherent integration pass.

### Sequencing constraints

- Node/Python Foundry request/response boundary before building the real chat.
- Agent identity and ticket authorization before expanding to multiple agents.
- Structured offerings and preflight before quote generation.
- Explicit consent and idempotency before any external side effect.
- Admin screens may be implemented against stable API fixtures while Node routes are being developed.
- OCR/Presidio can be built independently of n8n after data and upload contracts are frozen.
- The integrated P7 milestone is deliberately sequential.

## P0 contracts to establish now

- `agent_id` is server-trusted UUID, `agent_key` is a public alias; every ticket pins its Foundry published version.
- Minimal customer endpoints: `POST /api/v1/agents/{agentKey}/tickets`, `GET /api/v1/tickets/{ticketId}`, `POST /api/v1/tickets/{ticketId}/messages`; authenticated access is resolved server-side.
- SSE: `GET /api/events/tickets/{ticketId}`, with event IDs, replay cursor and per-ticket access checks.
- Internal gateway: `POST /internal/turns`, trusted agent/ticket/message/context payload, bounded validated response and typed errors.
- Later tools: `find_intents`, `get_intent_requirements`, `get_offerings`, `get_ticket_context`, `get_document_data`, `preflight_operation`, `propose_operation`, `get_operation_status`.
- Storage and action flow: accepted customer message first, persisted assistant result, independent authorization and verified n8n status.
- Host ingress: only Nginx `80:80`, internal Docker DNS for API, Python, Redis, PostgreSQL and n8n.
- POC auth: `AzureCliCredential` in the Python Linux container; persistent private CLI token cache with renewal as needed.

## MVP smoke gate per phase (not a hardening test suite)

Perform the smallest real execution check that verifies the phase is usable, and capture an error when it is not. Examples: app boot, HTTP health, clean SQL migration, live Foundry greeting/knowledge query, one persisted chat, one approved n8n provider outcome. No new E2E framework or benchmark harness during P0-P7.

## Reporting

At every phase boundary provide: exact branch/commit, files created/changed, working path, smoke result (if executable), dependencies, open blockers and next independent tracks. Mark unimplemented components as planned.

See [Testing and acceptance](09-testing-and-acceptance.md) for H1 hardening scope; P0-P7 do not claim those tests have passed.
