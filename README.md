# AI Service Agent — Gemini File Search experiment

**Active branch:** `experiment/gemini-file-search-poc`  
**Scope:** isolated Gemini POC, not a release or a replacement for `main`.

An agent-centric customer-service platform. Sara / ANCFZ is the example agent; the runtime and authorization are generic.

## Runtime

```text
Browser
  -> Nginx (localhost:2000)
    -> Next.js customer chat
    -> Node Fastify API (ticket/session acceptance, SSE, authorization)
      -> Gemini Developer API (model and agent-authorized functions)
      -> Gemini File Search (published per-agent knowledge only)
      -> independent Node grounding verifier
      -> PostgreSQL (ticket, 60-minute AI session, sources, events)
      -> Redis (ephemeral delivery/context)
      -> n8n (optional; Node-authorized lead/quote operations)
```

**Only one model turn worker:** `services/api/src/runtime/gemini-worker.ts`. The model does not own tickets, facts, permissions, workflow execution or provider status. Business claims need approved File Search evidence or a trustworthy, approved catalog revision; the independent Node verifier qualifies responses before assistant persistence and SSE.

AI conversation context expires after **60 minutes of inactivity** from the last accepted customer message. The next conversation starts a new AI session without old AI memory. Historical customer tickets/messages stay durably stored under authorization. Web browsing and URL/Google Search grounding are disabled.

## Status

P1–P7 implementation has been integrated, and the experiment's G0/P7 offline CI gates have passed at previously reported SHAs. **Real Gemini File Search citations/functions, approved Sara source ingestion, external n8n outcomes and full P6 live security/quality certification remain unverified.** Do not infer a live pass from the build or a skipped G1 workflow. Consult [P7 status](docs/gemini-p7-status.md) for exact evidence and blockers.

## Local setup

```bash
git switch experiment/gemini-file-search-poc
cp .env.example .env
# Set GEMINI_API_KEY, a random 32-byte hex GEMINI_STATE_ENCRYPTION_KEY,
# and different POSTGRES_PASSWORD / POSTGRES_APP_PASSWORD values privately.
docker compose config
docker compose up -d --build
docker compose ps
```

Host ingress is restricted to `127.0.0.1:2000`; the optional n8n editor uses `http://localhost:2000/n8n/` with the Compose `workflows` profile. Never reuse `main`'s volumes, state, n8n credentials or network. Local HTTP is **not** safe for public handling of customer PII or documents.

The migration entrypoint installs numbered SQL migrations `003`–`020` with checksum verification and seeds the pinned Sara Gemini agent. Migrations `001`/`002` and restricted runtime-role bootstrap initialize fresh PostgreSQL volumes. Never reset a real database simply to re-run init scripts.

## Repo layout

- `apps/web/` — Next.js chat and 60-minute session UX
- `services/api/src/gemini/` — model adapter and function continuation
- `services/api/src/knowledge/` — File Search ingestion, approved source originals
- `services/api/src/grounding/` — claim/evidence verifier
- `services/api/src/repositories/` — PostgreSQL agent, catalog, session and audit repositories
- `services/api/src/runtime/` — Fastify, single turn worker, tickets, SSE and approved action workers
- `services/api/src/integrations/gemini-n8n/` — authorized workflow adapter
- `infra/postgres/` — RLS migrations and isolated integration tests
- `tests/gemini/` — deterministic offline tests and external certification harness
- `docs/` — architecture, requirements, operating rules and status

An administrative GUI is deferred. Only scoped operator scripts and publication flows may manage knowledge or agent configuration.

The ANCFZ business-flow update from `main` adds an optional source-derived intent-action matrix, isolated n8n/2Checkout mock workflows, synthetic purchase/OTP/invoice APIs, and forward-only SQL `016`–`020`. All payment dispatch and identity OCR remain disabled unless configured; see [main integration record](docs/gemini-main-sync.md).

Start with [AGENTS.md](AGENTS.md), [documentation index](docs/README.md), [Gemini implementation plan](docs/gemini-experiment-implementation-plan.md) and [P7 status](docs/gemini-p7-status.md). No experiment code may be merged into or committed on `main`.
