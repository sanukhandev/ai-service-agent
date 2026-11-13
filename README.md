# AI Service Agent

A clean, generic **agent-centric AI business assistant** platform. ANCFZ / Sara is the first example, not a hardcoded business integration.

> **Status:** P0 scaffold committed: npm workspace, Node/Python health services, minimal Next.js and Angular shells, Nginx/Compose, initial PostgreSQL schema and shared API contract. **Images/builds, database initialization, Foundry calls and end-to-end runtime have not been executed or verified.** Foundry SDK integration is P1. Full automated testing and hardening are deferred until H1.

## Design

- **Next.js** customer portal for chat, tickets and secure forms.
- **Angular** static admin console served at `/admin/`.
- **Node.js / Fastify** authority for agent resolution, customers, tickets, catalogs, consent, events and n8n.
- **Python / FastAPI** gateway for existing Microsoft Foundry GPT-5.4 agents and Presidio PII processing.
- **Foundry IQ** attached to each agent for approved business knowledge.
- **PostgreSQL** for durable data; **Redis** for cache and transient coordination; **n8n** for approved external workflows.
- **Nginx** as the only host-published service, on **port 80**.
- **Tailwind CSS v4 + Inter (Google Fonts)** for both applications; simple UI components.

No tenant abstraction, LangGraph, pgvector or parallel legacy conversation engines.

## Source tree (planned)

```text
apps/web                  Next.js customer UI
apps/admin                Angular admin UI (built as static assets)
services/api              Fastify business authority
services/ai-gateway       FastAPI, Foundry and Presidio
packages/contracts        Shared request, event and tool contracts
infra/postgres            Fresh SQL schema/migrations
infra/nginx               Reverse proxy + admin static assets
infra/n8n                 Generic workflow definitions
docs                      Implementation design and acceptance
```

The folders above are **target structure**, not a claim that implementations are present.

## POC configuration

The Python gateway uses `AzureCliCredential` with an authenticated Linux Azure CLI cache in a private, persistent Docker volume. No Foundry credentials are embedded in images or committed. The live Foundry agent must be provisioned separately and bound by a versioned reference.

Only Nginx has `ports: ["80:80"]`. All other services remain on the internal Compose network. HTTP on port 80 is only appropriate for local/isolated testing; use an upstream HTTPS terminator before exposing personal data or OTP flows publicly.

## Where to start

1. Read [AGENTS.md](AGENTS.md).
2. Read [Documentation index](docs/README.md).
3. Follow [Implementation plan](docs/10-implementation-plan.md) and its acceptance gates.
4. Add runnable setup instructions and exact commands only after the corresponding code and Compose files exist.

Do not copy the old `agentic-rag-ai` runtime or its historical migrations. Port narrowly scoped, tested ideas when useful.

## Local P0 startup (once Docker is available)

The services are scaffolds, not a working AI assistant yet. Set a local database password and use the repository's Compose file:

```bash
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD to a strong local secret.
docker compose config
docker compose up -d --build
```

Only Nginx binds host port 80. Visit `http://localhost/` for the customer shell, `http://localhost/admin/` for the Angular shell and `http://localhost/api/health` for the Node health route. The Python gateway is internal at `ai-gateway:8000` and does **not yet** have Azure CLI installed in P0; P1 will add AzureCliCredential and the container login flow. `n8n` is currently behind the optional `workflows` Compose profile until P4.

No real customer data/OTP should be used over exposed HTTP. See [POC-first phases](docs/10-implementation-plan.md).
