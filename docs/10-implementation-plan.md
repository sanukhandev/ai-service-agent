# Implementation plan — thin vertical slices

## Current status

The new `ai-service-agent` repository began empty. This document set establishes architecture contracts; **no runtime code, database migrations, Compose manifests or live Foundry integration have been implemented by these documentation commits**.

Use the existing `agentic-rag-ai` repository only as a read-only reference for validated security/idempotency ideas. Do not merge its legacy sources or preserve V1/V2 APIs.

## Milestones and dependencies

| Milestone | Build | Definition of done |
|---|---|---|
| **P0 Foundation** | pnpm or npm workspace decision, TypeScript config, Python env, contracts, lint/test/build workflows, minimal Docker/Nginx and fresh PostgreSQL baseline | Fresh clone builds; only Nginx publishes :80; DB migrates from empty |
| **P1 Foundry live slice** | Python `AzureCliCredential`/Foundry client; Node scoped conversation route; Next.js bare chat | Real Sara greeting + cited package response, no LangGraph, no simulated tool |
| **P2 Persistence** | Agent/ticket/account/session repositories, message/event transactions, SSE + replay, Redis cache | Conversation persists and survives restart; no cross-agent leak |
| **P3 Business catalogs** | Versioned intents, requirements and offerings; model-visible function contracts; Node tool registry | Natural goal collection and catalog-backed responses |
| **P4 Authorized workflows** | `preflight_operation`, `propose_operation`, explicit approval API, outbox worker and generic n8n lead/quote flows | Verified provider result and idempotent retry/reconciliation |
| **P5 Customer services** | Secure email OTP, Presidio selective PII, private attachments, Azure Document Intelligence OCR | Auth and private documents work without entering model secrets |
| **P6 Admin + hardening** | Angular simple admin, publication/version controls, full integration and browser/security evaluation | Acceptance matrix in [testing](09-testing-and-acceptance.md) passes with traceable evidence |

Milestones order the *integration path*, not forbid parallel implementation. Prefer shipping a functioning narrow P1 rather than building all screens and adapters before first live model invocation.

## P0 shared contracts to freeze

Before parallel work, agree on:
- `agent_id` UUID, `agent_key` alias, active Foundry name/version and knowledge binding.
- Ticket/message/event IDs and `request_id` dedupe; role/order; trusted session ownership.
- `POST /api/v1/tickets` (guest/new ticket), `POST /api/v1/tickets/:ticketId/messages`, `GET /api/v1/tickets/:ticketId`, `GET /api/events/tickets/:ticketId` (SSE), plus health.
- Internal `POST /internal/turns` Node->Python response shape, service authentication and typed errors.
- Tool names: `find_intents`, `get_intent_requirements`, `get_offerings`, `get_ticket_context`, `get_document_data`, `preflight_operation`, `propose_operation`, `get_operation_status`.
- Consent/operation states; provider evidence and callbacks.
- Frontend event payload and Last-Event-ID/replay semantics.
- Minimal POC config/env naming, health and process shutdown behavior.

Paths are **proposed contracts** until implemented and tests confirm; avoid claiming existing endpoints.

## Safe parallel workstreams

After P0 contracts are reviewed and committed:

| Track | Exclusive ownership | Can run in parallel with |
|---|---|---|
| A: DB | `infra/postgres/`, Node repositories and DB isolation tests | B, C, D, E |
| B: Foundry | `services/ai-gateway/`, SDK/auth integration and Python tests | A, C, D, E |
| C: Next web | `apps/web/` plus browser mocks/E2E fixtures | A, B, D, E |
| D: Admin | `apps/admin/` plus static build | A, B, C, E |
| E: n8n | `infra/n8n/`, callback fixtures/workflow tests | A, B, C, D |
| Integration owner | `services/api/` composition/API routes, `docker-compose.yml`, Nginx, shared contracts and CI | Merge **after** interfaces stabilize; avoid competing writers |

Use independent feature branches/worktrees for parallel tracks. Commit and test each, then integrate against the latest target branch; no tool should run live work under the pretense of background execution.

## Implementation constraints

- No runtime auto-provisioning of Sara or AI Search; bind to a manually tested published Foundry agent and pinned version.
- No duplicated knowledge path: native IQ retrieval only for this POC.
- No direct browser-to-Python/Foundry/n8n calls.
- No blanket prompt PII scrubbing that breaks customer-approved lead collection.
- No fixed seven-stage ANCFZ workflow; workflows/requirements come from versioned catalogs.
- Only Nginx port 80 publicly mapped in Compose; Angular compiled to static assets.
- No complex component libraries; both UIs use Tailwind v4 + locally delivered Inter.
- Do not publish OTP/docs/PII over publicly accessible unencrypted HTTP.
- No real secrets or user-provided admin password committed to source.

## Initial work tickets

1. Setup repository baseline and CI with actual running lint/build/test commands.
2. Implement PostgreSQL migration 001 + agents/tickets/messages/events.
3. Implement Python Foundry `AzureCliCredential` client with documented env and test a real published Sara version.
4. Connect Node -> Python with service-auth contract; persist two-sided transcript.
5. Implement minimal Next chat + Nginx routing + SSE.
6. Run real Foundry IQ retrieval tests for FAQ, company types, packages and pricing; fix retrieval/source configuration before expanding functionality.
7. Add tool registry and intent/offering read tools.
8. Add n8n operations with consent and verified outcomes.
9. Add OTP, documents/OCR, Presidio and admin screens.
10. Certify agent isolation, idempotency, Docker-only port exposure and browser flows.

## Reporting standard

For each milestone: enumerate committed file changes, exact head SHA, test commands, pass/fail results, external service tests and unresolved blockers. A module that only exists in docs is **planned**, not implemented.
