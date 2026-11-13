# AGENTS.md — AI Service Agent engineering contract

Status: **design baseline**. This repository is a clean rebuild; the architecture documentation is not evidence that runtime code exists.

## 1. Product and non-negotiable decisions

Build a **generic, agent-centric business assistant platform**. ANCFZ / Sara is the first example configuration, not a domain baked into application code.

- **Agent** is the primary business/security partition. No Tenant entity or `tenant_id` compatibility layer.
- **Microsoft Foundry Agent Service** owns model reasoning, dialogue and native Foundry IQ retrieval. Reuse existing, versioned agents; never create an agent automatically for every session.
- **Foundry IQ** owns business knowledge indexing/retrieval. Do not add application pgvector, embedding tables, or duplicate RAG engines.
- **Node.js Fastify API** owns trusted agent resolution, identity, tickets, durable state, catalog data, tool authorization, consent, business operations and SSE.
- **Python FastAPI gateway** invokes Foundry, mediates registered application function calls, handles time budgets and integrates Presidio for selective PII detection.
- **PostgreSQL 16** stores authoritative application state; **Redis** provides ephemeral context/OTP/event distribution, never sole persistence.
- **n8n** performs only explicitly authorized, backend-dispatched operations; provider evidence confirms outcomes.
- **Next.js customer web**, **Angular admin**, **Nginx** public reverse proxy/static server.
- **Only Nginx publishes host port 80**. All other containers have **no host ports**. Internal service-to-service calls use Docker DNS, not Nginx.
- **Tailwind CSS v4 + Google Font Inter** in both UIs. Prefer self-hosted font files/assets from a legitimate package or build pipeline. Keep interfaces simple, accessible and responsive; avoid heavy UI kits.

No LangGraph, hand-built model planner, scripted seven-stage dialogue, V1/V2 compatibility, legacy migration history, multiple competing chat paths, or unnecessary microservices.

## 2. Code layout (target)

- `apps/web/` — Next.js customer chat and tickets.
- `apps/admin/` — Angular admin UI; compile to static files served by Nginx at `/admin/`.
- `services/api/` — Node/Fastify business API, database access, event delivery and operation authority.
- `services/ai-gateway/` — Python/FastAPI Foundry adapter, function-call bridge and Presidio.
- `packages/contracts/` — versioned schemas/types shared at service boundaries.
- `infra/postgres/` — fresh SQL schema and forward migrations.
- `infra/nginx/` — Nginx reverse proxy plus Angular static delivery.
- `infra/n8n/` — exported, generic workflow templates.
- `docs/` — normative design, contracts, operations, implementation and acceptance.

Do not create empty scaffolding packages just to mirror this tree. Create directories as the corresponding functionality is implemented.

## 3. Runtime ownership

Browser -> Nginx -> Node API -> Python AI Gateway -> published Foundry Agent -> Foundry IQ. A registered Foundry function call returns to Python -> **Node tool registry**, then back to Foundry with a validated result. Native Foundry IQ retrieval is the **only RAG path for this POC**; note that native retrieval does not traverse Node's tool gateway.

- Node derives `agent_id`, session, ticket and permissions from authenticated/server-side context, never trusts model-supplied scope.
- Node persists accepted customer messages **before** invoking the model and persists validated assistant results/events. SSE delivers durable event IDs with replay/reconnect.
- Model-generated text is never authority to create accounts, close tickets, price offers, execute workflows or assert provider success.
- Publish only supported agent function schemas; a tool call cannot bypass Node authorization, validation, idempotency or explicit action consent.
- Catalog data is structured and versioned: intents/requirements, offerings/prices and action/workflow bindings. RAG explains facts; structured catalogs control formal quotes.
- Separate private ticket uploads/Document Intelligence OCR from the approved shared Foundry IQ knowledge base.

## 4. Foundry and POC authentication

Use configured Foundry **project endpoint**, published **agent name and pinned version**, not an assumed direct model endpoint. GPT-5.4 is the initial model as deployed in the project.

For the **local POC**, authenticate the Python gateway using `AzureCliCredential` and a persistent, private Docker named volume containing Linux Azure CLI state. Install Azure CLI in that image; perform the initial device-code login in that container. Rebuilds/restarts should preserve the cache, but revocation or expired sign-in policies can require login again. **Never** commit/mount the host's Windows token cache into a Linux image, bake credentials into layers, or expose the volume to other services. Use managed identity in deployed environments.

Do not implicitly provision, mutate or delete Foundry agent versions, knowledge sources or index data from customer-message handlers. Administrator-triggered provisioning must be explicit and audited.

## 5. Data isolation, privacy and operations

- Use `agent_id` on all agent-owned rows, identifiers, object paths, tool grants and external correlation records. Enforce via scoped queries, constraints and PostgreSQL RLS where appropriate.
- Persist minimal conversational facts and relevant customer details; restrict access by account/ticket/agent. Use structured collection and encryption for sensitive fields.
- Use `presidio-analyzer` / `presidio-anonymizer` rather than custom name/email detection. Detection is fallible; selectively mask data not needed by the agent. Do not erase legitimate contact information needed for consented business operations.
- OTP, passwords, API keys, access tokens and payment credentials **never enter prompts, Foundry, chat logs or telemetry**. OTP verification runs in Node and secure UI endpoints.
- Tools return typed, bounded, redacted responses. Do not let retrieved documents or model responses override system policy.
- Every state-changing operation requires server-side preflight, explicit customer authorization when applicable, idempotency key, durable request/outbox, and independently verified result. Calling n8n successfully is not verified business completion.
- Never commit secrets or sample real customer data. Repo is presently public; treat it as public source even when using local Azure authentication.

## 6. Public routing and UI

- `/` -> Next.js; `/admin/` -> Angular static assets; `/api/` -> Node; `/api/events/` -> SSE with Nginx proxy buffering disabled.
- Only `nginx` may have Compose `ports: ["80:80"]`; no other service publishes host ports. Do not accidentally expose n8n editor or PostgreSQL.
- Bind browser APIs same-origin behind Nginx; do not put Foundry keys, Azure CLI, Node service credentials or internal URLs in client bundles.
- Keep Next.js and Angular screens simple: chat/messages, ticket status, forms, tables, clear loading/error states, accessible keyboard controls. Use native HTML + Tailwind; introduce a component library only with an explicit need.
- Port 80 is **HTTP**. This is for localhost or isolated POC networks. Do not expose customer OTP/PII/documents on public HTTP; require upstream HTTPS before public access.

## 7. Engineering workflow and quality gates

1. Read `docs/README.md` and the relevant contract before implementation.
2. Implement a **single** API/schema/flow, not parallel old and new paths.
3. Keep service modules cohesive; prefer replacing an obsolete module over adding wrappers or dead branches.
4. Freeze API/tool/event contracts before parallel frontend/backend/workflow development.
5. Use additive migration files **after** the new fresh baseline; do not edit migrations already used by a persistent environment. Never run volume deletion/migration resets against a populated database without explicit approval.
6. For P0-P7, prioritize implementing the working POC with accurate documentation, successful builds/migrations and minimal live smoke verification. Defer dedicated unit/contract/integration/E2E suites, benchmarking and comprehensive CI to H1 after POC completion; never claim unrun tests passed. Do not defer necessary agent isolation, authorization, OTP protection, action consent, validation or secret handling.
7. Do not claim a live Azure/n8n integration passed from mock tests alone; report exact commands, environment, results, blockers and commit SHA.
8. Never put secrets, tokens, OTPs or raw PII in fixtures, screenshots, errors, traces or PR logs.

## 8. MVP priorities

P0: shared contracts, workspace and Compose foundation -> P1: Foundry Gateway live invocation -> P2: Node tickets, PostgreSQL, SSE and minimal Next.js chat -> P3: catalogs and read tools -> P4: approved n8n actions -> P5: OTP, private documents/OCR and Presidio -> P6: Angular admin -> P7: integrated functional POC -> H1: automated tests, security/performance hardening and full CI. Keep initial scope tight; don't build speculative abstractions.

## 9. Reference documents

Start at [docs/README.md](docs/README.md). Especially:
- [Product and scope](docs/01-product-and-scope.md)
- [Architecture](docs/02-architecture.md)
- [Foundry and conversation](docs/03-foundry-and-conversation.md)
- [Data model](docs/04-data-model.md)
- [Tools and operations](docs/05-tools-actions-workflows.md)
- [Security and privacy](docs/06-security-and-privacy.md)
- [Docker and deployment](docs/07-docker-and-deployment.md)
- [UI guidelines](docs/08-ui-guidelines.md)
- [Testing](docs/09-testing-and-acceptance.md)
- [Implementation plan](docs/10-implementation-plan.md)

When documentation and an implemented contract diverge, record the discrepancy and update the documentation with the reviewed change. Do not quietly invent behavior.
