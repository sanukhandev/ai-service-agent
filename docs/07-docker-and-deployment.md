# Docker Compose and Nginx — Gemini experiment

## Only public host port: 2000 (separate from Foundry main)

The **only** host-published service is experiment Nginx on `127.0.0.1:2000:80`. Its internal container port remains 80. The Foundry main stack can simultaneously publish `127.0.0.1:80:80`. The Compose project name is `ai-service-agent-gemini`, with dedicated PostgreSQL, Redis, n8n and Azure CLI volumes and dedicated networks. **Do not reuse main's `.env`, database volumes, n8n encryption key or credentials.** Next.js `web:3000`, Node `api:4000`, PostgreSQL `postgres:5432`, Redis `redis:6379` and optional n8n `n8n:5678` run inside the Compose network without host `ports:`.

```text
Browser -> http://localhost:2000 -> experiment Nginx
  /            -> web:3000 (Next.js)
  /api/        -> api:4000 (Fastify)
  /api/events/ -> api:4000 (SSE, buffering off)
Node API -> Gemini + Gemini File Search over outbound HTTPS (planned; current runtime is still Foundry-based until replacement is implemented)
Node API -> PostgreSQL, Redis, private n8n within Docker DNS
```

No Angular/static admin asset stage and no Python Model Gateway. The private n8n editor is available at `http://localhost:2000/n8n/` only while the optional `workflows` Compose profile is running. Public n8n webhook/form/MCP ingress remains blocked by Nginx.

## Docker network segregation

Compose uses `frontend` for Nginx, Next.js and Node, plus `backend` for Node, PostgreSQL, Redis and n8n. **Nginx and Node join both networks** to allow the optional private n8n editor proxy. The customer web service cannot reach n8n, PostgreSQL or Redis directly. No backend service publishes a host port.

## P0 infrastructure files

- `docker-compose.yml` is the single Compose definition.
- `infra/nginx/default.conf` handles reverse proxy and SSE.
- `infra/nginx/Dockerfile` builds Nginx only.
- `services/api/Dockerfile` runs Node/Fastify; P1 must add Azure CLI to this image.
- `apps/web/Dockerfile` runs the minimal Next.js shell.
- `infra/postgres/001_core.sql` defines agent/ticket/message/event baseline.
- `infra/postgres/002_intents_and_ticket_facts.sql` defines intent/offerings and fact persistence.
- `infra/bootstrap/003-app-runtime-role.sh` creates the least-privileged `agent_runtime` DB login and grants SELECT on published catalogs plus read/write access to ticket tables.

The SQL scripts and role-bootstrap shell script mount into `/docker-entrypoint-initdb.d`; **Postgres executes them only on fresh initialization**, not on an existing persistent data volume. For an existing DB, run the new forward migration through the approved migration mechanism. Do not delete the volume to force it.

## Local Azure CLI login (P1)

The private volume `azure-cli-auth` is mounted at `/home/app/.azure` in **Node API only**, with `AZURE_CONFIG_DIR` set. The runtime image must be updated to include Linux Azure CLI and a writable non-root cache in P1. Then `docker compose exec api az login --use-device-code` and `docker compose exec api az account show` can establish and check local credentials. AzureCliCredential will use those credentials to call the configured Foundry project and pinned Sara version.

The volume persists after rebuilding/recreating containers, but Azure sign-in can expire or be revoked; no promise of permanent authentication. Do not mount Windows Azure cache in Linux or commit token files.

## Runtime DB password and privilege boundary

Local `.env` must contain **different strong values** for `POSTGRES_PASSWORD` (migration owner) and `POSTGRES_APP_PASSWORD` (Node runtime role). Compose supplies Node with `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER=agent_runtime` and `PGPASSWORD`; avoid mixing it with the superuser account. The role setup runs **only on a fresh PostgreSQL volume**. Existing databases need an explicit, reviewed forward initialization/privilege step; no automatic data reset. Future schema migrations also require appropriate grants for newly created runtime tables.

## Local startup after configuration

```bash
cp .env.example .env
# Set distinct POSTGRES_PASSWORD and POSTGRES_APP_PASSWORD in the private .env
docker compose config
docker compose up -d --build
docker compose ps
# With the two DB passwords exported to your shell, optionally run:
bash scripts/p0-smoke.sh
```

Expected experimental endpoints *after images start*: `http://localhost:2000/` (customer shell), `http://localhost:2000/api/health` (Fastify health), optionally `http://localhost:2000/n8n/` (private editor). The Gemini model integration has not yet been implemented.

## POC safety and constraints

- Port 2000 is HTTP and suitable only for localhost/isolated testing. Use upstream HTTPS before handling real customer PII, OTP or uploads publicly.
- No public n8n editor, private database, Redis, Node or Foundry credential endpoint.
- Preserve the explicitly named `ai-service-agent-gemini-*` volumes; `docker compose down -v` deletes experimental data. Never delete or mount Foundry main volumes.
- Node uses the restricted **non-superuser** PostgreSQL `agent_runtime` role and transaction-local agent RLS context; never use the migration owner for application queries.
- Do not claim images built or live Azure access verified until actual Docker commands run in a Docker-enabled environment.
