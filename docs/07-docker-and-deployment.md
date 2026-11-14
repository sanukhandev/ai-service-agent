# Docker and deployment — isolated Gemini experiment

## Fixed isolation

`docker-compose.yml` defines the project `ai-service-agent-gemini`. Only Nginx publishes `127.0.0.1:2000:80` on the host. Internal services use `web:3000`, `api:4000`, `postgres:5432`, `redis:6379`; optional `n8n:5678` runs under `--profile workflows`. Postgres, Redis, Node and n8n have **no host-published port**.

The experimental volumes are explicitly named `ai-service-agent-gemini-postgres-data`, `ai-service-agent-gemini-redis-data` and `ai-service-agent-gemini-n8n-data`. Never share or delete another Compose project's state or credentials.

```text
http://127.0.0.1:2000
  /            -> Next.js (web)
  /api/        -> Fastify (api)
  /api/events/ -> durable SSE replay
  /n8n/       -> optional private editor proxy
Node -> Gemini Developer API / File Search (outbound HTTPS)
Node -> PostgreSQL / Redis / optional n8n (Docker DNS)
```

No Azure CLI, custom vector DB, Python AI/Model Gateway or Angular admin image is required.

## Environment

```bash
git switch experiment/gemini-file-search-poc
cp .env.example .env
# Set private GEMINI_API_KEY
# Generate a private 32-byte hex GEMINI_STATE_ENCRYPTION_KEY:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Set different POSTGRES_PASSWORD and POSTGRES_APP_PASSWORD.
docker compose config
docker compose up -d --build
docker compose ps
```

Use a private approved-originals root for operator-side ingestion and a read-only normalized-text mount for Node verification. Approved documents must be explicitly published. `GEMINI_MODEL_ID` pins **newly seeded** agent versions; changing an existing published agent requires controlled version publication, not an implicit rewrite.

The API requires its Gemini key and encryption key and does not fall back to another model. Before starting on an existing DB, verify versioned agent configuration and migrations.

## PostgreSQL bootstrapping

A fresh Postgres volume initializes `001_core.sql`, `002_intents_and_ticket_facts.sql`, then the role bootstrap `infra/bootstrap/003-app-runtime-role.sh`. The one-off `migrate` service applies sequential forward migrations `003`–`015` with immutable checksums and idempotently seeds the Sara Gemini version. The Node API connects only as `agent_runtime`; it must not use the migration-owner password.

Do not edit historical SQL migration content; the migration runner rejects changed checksums. Do not delete a persistent volume to re-run initialization. Test isolated changes using `bash infra/postgres/gemini-p2-validate.sh` in a disposable Compose project.

## Operations and diagnostics

```bash
docker compose config --quiet
docker compose ps
docker compose logs --no-color --tail=100 api postgres migrate nginx
curl --fail http://127.0.0.1:2000/api/health
```

A local smoke script `bash scripts/p0-smoke.sh` verifies the dedicated network/port, Node health, web and restricted PostgreSQL role when its required environment credentials are supplied. Optional n8n configuration is explained in `infra/n8n/ancfz/SEEDING.md`.

The G1 live synthetic File Search probe is **explicit opt-in and potentially billable**. Review `docs/gemini-p7-status.md` before triggering it; no Google credentials or customer documents belong in a GitHub commit.

## Security boundaries

- Local port 2000 uses HTTP and is **not** approved for publicly exposed PII, OTP or customer documents. Use upstream TLS and access controls before external deployment.
- n8n webhooks, private network endpoints and persistent state must not be exposed from the browser.
- Keep migration owner, Node runtime, model key and n8n secrets separate.
- Never run `docker compose down -v` against a non-disposable project or another application's named volumes.
- Do not label a successful Docker build as proof of a live Gemini or provider integration.
