# AI Service Agent — POC

A clean, generic **agent-centric business assistant** platform. Sara/ANCFZ is the first example, not business logic hardcoded into the runtime.

> **Current status:** P3 Node runtime integration was merged to `main` (exact-head P0/P2/P3 offline CI passed); **live Sara / Foundry IQ validation remains pending**. ANCFZ-only P4 n8n workflow templates are included as **inactive integration starters**; they are **not wired to the Node authorization/OTP runtime or tested against providers**. Do not treat the POC as complete. Angular admin and Python Gateway are excluded.

## Active architecture

Browser -> **Nginx (public port 80 only)** -> **Next.js customer app / Fastify Node API**.

The Node API connects directly to:
- **Microsoft Foundry Agent Service**, using the existing, versioned GPT-5.4 Sara agent and attached **Foundry IQ** knowledge base.
- **PostgreSQL 16**, for authoritative agent/ticket/message/catalog state.
- **Redis**, for ephemeral context and event coordination.
- **n8n** (optional Compose `workflows` profile until P4), for server-authorized operations only.

No Python runtime, Angular admin, LangGraph, pgvector, custom embedding service or tenant entity is needed for this POC.

## Source layout

```text
apps/web/                Next.js + Tailwind v4 + self-hosted Inter
services/api/            Node Fastify; Foundry SDK added in P1
packages/contracts/      Public API and event contracts
infra/postgres/          Agent-scoped SQL, migration ledger, durable turn queue
infra/nginx/             Port-80-only reverse proxy
docs/                    Engineering contract, plan and reference
docker-compose.yml       Local/isolated deployment
AGENTS.md                Repository development contract
```

**Admin Portal is explicitly deferred to a later milestone.** The future admin implementation is not part of P0–P7 POC acceptance. Agent/catalog configuration can initially use authenticated internal scripts or controlled seeds. No browser-accessible admin endpoint is planned yet.

## POC authentication

For P1, Node will use `@azure/ai-projects` and `@azure/identity` with `AzureCliCredential`. The private Docker `azure-cli-auth` volume is mounted **only in the Node API container**. P0's API image does **not** yet install Azure CLI, so do not expect an `az login` command to work until P1 implements that. Credentials persist across rebuilds when the volume and login remain valid.

## ANCFZ P4 workflows (draft)

Ticket creation remains a **direct Node/PostgreSQL operation**. ANCFZ has a separate n8n integration pack for Salesforce Lead upsert, PDF quotation/invoice generation, MockGateway **test** payment links, independent payment verification, and email delivery of Node-generated OTP. Customer approval and one-time OTP are required before generating a test payment link; a customer saying they paid never substitutes for independent verification.

See [ANCFZ P4 business workflow contract](docs/ancfz-p4-workflow-contract.md) and [n8n import templates](infra/n8n/ancfz/README.md). The workflow JSON is **inactive** and not yet connected to Node, so do not enable it prematurely. The ANCFZ MockGateway demo Orders POST is configured, but checkout URL and payment verification remain unavailable until the matching provider response/status API is validated.

## Local P0 configuration

```bash
cp .env.example .env
# Set DIFFERENT strong POSTGRES_PASSWORD and POSTGRES_APP_PASSWORD values.
docker compose config
docker compose up -d --build
docker compose ps
# Once P0 services are up, verify public routes and runtime DB role:
# export POSTGRES_PASSWORD and POSTGRES_APP_PASSWORD from your local .env
# bash scripts/p0-smoke.sh
```

The official PostgreSQL image initializes `001_core.sql`, `002_intents_and_ticket_facts.sql`, then `infra/bootstrap/003-app-runtime-role.sh` on a **fresh** data volume. The dedicated `migrate` service applies `003–006`, checks checksums, and idempotently seeds Sara and published catalogs before API startup. It creates a restricted `agent_runtime` role for the Node service; the `postgres` migration owner must not be used for application queries. Do not delete an existing volume to re-run init scripts. Track B owns any follow-up migrations and grants for new tables.

Set the real `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_NAME` and `FOUNDRY_AGENT_VERSION` before starting the migration service. Changes to an existing published binding require explicit version publication, not silent seed mutation. See [P3 publication](docs/p3-foundry-runtime-and-publication.md).

Only Nginx publishes host port 80. `http://localhost/` is the Next.js shell, and `http://localhost/api/health` is the Node health endpoint. These commands have not been executed/verified in this repository session.

**Port 80 uses unencrypted HTTP:** Local/isolated POC only. Before public access with real customer PII, OTP or documents, add HTTPS at the ingress.

Read [AGENTS.md](AGENTS.md), [documentation index](docs/README.md) and the [POC-first implementation plan](docs/10-implementation-plan.md).
