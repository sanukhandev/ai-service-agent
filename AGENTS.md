# AGENTS.md — AI Service Agent development contract

## 1. Current scope (POC)

Build one generic, **agent-centric** business assistant platform. Sara / ANCFZ is an example configuration. The repository is a clean rebuild, not a migration of old `agentic-rag-ai` code.

**Active components:** Next.js customer UI, Node.js Fastify API, PostgreSQL 16, Redis, Nginx (port 80 only), optional n8n workflows and the existing external Microsoft Foundry Agent Service + Foundry IQ.

**Explicitly excluded from this POC:** Angular admin UI, Python AI/Model Gateway, Presidio Python service, LangGraph, pgvector, custom embedding/RAG engine, a Tenant entity, legacy V1/V2 compatibility, complex component kits, and fixed seven-stage dialogue engines. Admin UI remains a **future separate milestone**; do not recreate its scaffold or route during P0–P7.

## 2. Core architecture

Browser -> Nginx -> Next.js / Node Fastify -> existing **published Foundry Agent GPT-5.4** and its native **Foundry IQ** retrieval.

- Node invokes Foundry directly using the supported JavaScript/TypeScript SDK. Keep a small `foundry-client` adapter and one conversation orchestration path within `services/api/`.
- Node handles Foundry client-executed **function calls locally** through an allowlisted tool registry. Never route application tool calls through a Python gateway. Keep native Foundry IQ knowledge MCP attached to the agent; do not duplicate knowledge retrieval.
- Node is the sole authority for agent identity, guest/customer ownership, tickets, durable messages and events, catalog versions, customer consent, workflow authorization and provider evidence.
- Agent is the isolation root; every agent-owned row, ticket and workflow binding is scoped by trusted server-derived `agent_id`. No `tenant_id` compatibility layer.
- Business functions start with `find_intents`, `get_intent_requirements`, `get_offerings`, `get_ticket_context`, `get_document_data`, `preflight_operation`, `propose_operation` and `get_operation_status` (introduce gradually).
- Each action requires Node preflight and explicit customer authorization for consequential side effects. n8n runs from authorized Node dispatch only; HTTP acceptance is not evidence of provider completion.
- PostgreSQL is the authority; Redis is ephemeral cache/fanout. Persist customer and assistant message/events durably, SSE with replay. Keep private document uploads apart from Foundry IQ.

## 3. Foundry authentication for local POC

Use `@azure/identity`'s **AzureCliCredential** in Node, and an existing published Foundry agent project/name/version binding. Do not create or mutate agents or IQ sources on each customer message.

Node API Docker image will install the Linux Azure CLI in **P1**. Persist Linux Azure CLI state in a private Docker named volume mounted to `/home/app/.azure`, with `AZURE_CONFIG_DIR` and correct writable ownership for the runtime user. Run device-code login in that container after CLI installation, and verify live Foundry access. Restarts/rebuilds preserve the volume; credentials may still expire or be revoked. Never commit tokens or attempt to mount Windows Azure CLI credential caches into Linux. Use managed identity after the local POC.

## 4. Deployment and UI rules

- Only `nginx` publishes `ports: ["80:80"]`. No host ports on Node, Next.js, PostgreSQL, Redis or n8n.
- Public routes: `/` -> Next.js `web:3000`, `/api/` -> Node `api:4000`; `/api/events/` -> Node SSE with Nginx buffering disabled.
- **No `/admin/` route** or Angular build stage in the active deployment.
- Internal calls use Docker DNS, not an Nginx round-trip.
- Next.js uses Tailwind CSS v4, Inter from Google Fonts **self-hosted** via package/build, minimal semantic HTML, small reusable local components and Lucide icons where needed. No complex dashboard/component libraries.
- HTTP on port 80 is for localhost/isolated POC only. Never expose real OTP/PII/customer uploads over public HTTP. Add upstream TLS before public use.

## 5. Privacy, identity and data

- Authenticate guests/customers in Node and bind their tickets to a server-verified agent/session; never trust model-supplied IDs, operations, prices or permissions.
- Keep OTP/password/credentials outside prompts, chat messages and telemetry. OTP is handled by Node and secure UI endpoints in P5.
- **PII approach:** no Python just for Presidio. Keep a small replaceable Node privacy adapter, with Azure AI Language PII as an optional P5 provider, plus structured input validation, scoped storage and logging redaction. Do not blindly mask necessary consented contact data. PII detection is never a substitute for security.
- Use normalized PostgreSQL with composite agent-scoped FKs and RLS where practical. Do not import old migrations or create pgvector.
- Version intents, requirements, offerings/prices and agent permissions; use structured offerings for formal quotes and IQ only for descriptive knowledge.
- Admin-style configuration during POC must be through an authenticated local CLI or one-time controlled seed. No unauthenticated management endpoints; no hardcoded admin credentials.

## 6. Implementation phases

P0: foundation/Compose/contract -> P1: **Node direct Foundry integration** -> P2: ticket persistence, Next.js chat and SSE -> P3: intent/offering tools -> P4: customer-authorized n8n workflows -> P5: OTP, private uploads/OCR and optional PII detection -> P6: functional integration -> P7: demonstrable POC -> H1: automated testing/security/performance hardening.

**Admin UI is deferred beyond the POC** and will have its own future milestone. Do not put an admin UI delivery gate into P0–P7.

For P0–P7, prioritize functionality, successful builds/migrations and minimal live smoke verification. The dedicated unit/contract/E2E suites, benchmarking and comprehensive CI come later in H1. Do not defer basic authorization, input validation, secret protection or action consent.

## 7. Engineering discipline

1. Read [docs/README.md](docs/README.md), [architecture](docs/02-architecture.md) and the [implementation plan](docs/10-implementation-plan.md) before implementing.
2. Keep one authoritative conversation path; don't add compatibility wrappers or parallel planners.
3. Freeze API/tool/event contracts before concurrent work; maintain a single owner for shared contracts/Compose/Nginx.
4. Never claim live Foundry, n8n or Docker success when only a scaffold or mock exists. Give exact SHA, commands actually executed, outcomes and blockers.
5. Avoid destructive migrations/data resets without explicit approval. Do not commit real secrets, personal data or production customer documents.
6. When scope changes, update the runtime configuration, documentation and development milestones together.
