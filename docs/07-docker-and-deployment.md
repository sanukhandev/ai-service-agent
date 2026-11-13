# Docker Compose and Nginx — current POC

## Only public host port: 80

The **only** host-published service is Nginx on `80:80`. Next.js `web:3000`, Node `api:4000`, PostgreSQL `postgres:5432`, Redis `redis:6379` and optional n8n `n8n:5678` run inside the Compose network without host `ports:`.

```text
Browser -> http://localhost:80 -> Nginx
  /            -> web:3000 (Next.js)
  /api/        -> api:4000 (Fastify)
  /api/events/ -> api:4000 (SSE, buffering off)
Node API -> Foundry Agent GPT-5.4 / Foundry IQ over outbound HTTPS
Node API -> PostgreSQL, Redis, private n8n within Docker DNS
```

No Angular/static admin asset stage and no Python Model Gateway. Do not add `/admin/`, `/ai-gateway/` or `/n8n/` proxy routes in this POC. n8n remains behind an optional `workflows` Compose profile until P4.

## Docker network segregation

Compose uses `frontend` for Nginx, Next.js and Node, plus `backend` for Node, PostgreSQL, Redis and n8n. **Only Node joins both networks**. The customer web service cannot reach n8n, PostgreSQL or Redis directly. No backend service publishes a host port.

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

Expected public endpoints *after images start*: `http://localhost/` (customer shell), `http://localhost/api/health` (Fastify health). The actual Foundry chat is not present until P1/P2.

## POC safety and constraints

- Port 80 is HTTP and suitable only for localhost/isolated testing. Use upstream HTTPS before handling real customer PII, OTP or uploads publicly.
- No public n8n editor, private database, Redis, Node or Foundry credential endpoint.
- Preserve `postgres-data`, `redis-data`, `n8n-data` and `azure-cli-auth`; `down -v` deletes these.
- Node uses the restricted **non-superuser** PostgreSQL `agent_runtime` role and transaction-local agent RLS context; never use the migration owner for application queries.
- Do not claim images built or live Azure access verified until actual Docker commands run in a Docker-enabled environment.
