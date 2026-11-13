# Docker Compose and Nginx deployment

## Public network contract

**Exactly one published host port: `nginx:80`.** No `ports:` on `web`, `api`, `ai-gateway`, `postgres`, `redis` or `n8n`. `expose:` is optional container metadata, not a host port mapping.

Internal service calls use Docker DNS names:
- Nginx -> `web:3000` or `api:4000`
- Node -> `ai-gateway:8000`, `postgres:5432`, `redis:6379`, `n8n:5678`
- Python -> Microsoft Foundry via outbound HTTPS.
- Node -> Blob/Document Intelligence via outbound HTTPS when enabled.

Never route private Node->Python/n8n requests out through public Nginx.

## Compose target

```yaml
name: ai-service-agent
services:
  nginx:
    build:
      context: .
      dockerfile: infra/nginx/Dockerfile
    ports: ["80:80"]
    depends_on: [web, api]
  web:
    build: ./apps/web
    # No ports. Internal Next.js listens at 3000.
  api:
    build: ./services/api
    # Internal Fastify listens at 4000.
  ai-gateway:
    build: ./services/ai-gateway
    environment:
      AZURE_CONFIG_DIR: /home/app/.azure
    volumes:
      - azure-cli-auth:/home/app/.azure
    # Internal FastAPI listens at 8000.
  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres-data:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
  n8n:
    # Pin tested version. Never publish editor port.
    image: docker.n8n.io/n8nio/n8n:<PINNED_VERSION>
    volumes:
      - n8n-data:/home/node/.n8n
volumes:
  azure-cli-auth:
  postgres-data:
  redis-data:
  n8n-data:
```

**Illustrative design only:** Replace image placeholders, implement Dockerfiles, secure environment injection, health checks, migration job and service config before running. Do not paste this snippet as production-ready Compose.

The Angular admin is a **build-stage artifact copied into the Nginx image**, served at `/admin/`. There is no Angular development server in runtime Compose. Add only an opt-in development profile if live reload is truly needed.

## Public route table

| Path | Target | Notes |
|---|---|---|
| `/` | Next.js `web:3000` | Customer UI |
| `/admin/` | Nginx static files | Angular build with base path `/admin/` |
| `/api/` | Fastify `api:4000` | Authenticated/same-origin browser API |
| `/api/events/` | Fastify SSE | Nginx buffering off; durable replay |

Do not publish private `/ai-gateway/`, `/n8n/`, database, Redis or health endpoints containing secrets through Nginx.

## Nginx important directives

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    client_max_body_size 20m;

    location = /admin { return 301 /admin/; }
    location /admin/ { try_files $uri $uri/ /admin/index.html; }

    location /api/events/ {
        proxy_pass http://api:4000;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /api/ {
        proxy_pass http://api:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If using streaming/chat upgrades in development, test required headers separately. SSE uses `text/event-stream` with durable cursor-based replay; no WebSocket dependency.

## Azure CLI in Docker

- Image must include Linux Azure CLI and Python `azure-identity`, with a nonroot writable `AZURE_CONFIG_DIR`.
- Store CLI session in private volume `azure-cli-auth`; **do not** bind-mount Windows `.azure` cache.
- After Compose is implemented: `docker compose exec ai-gateway az login --use-device-code` once; verify `az account show` and an actual Foundry agent invocation.
- Restart/rebuild should preserve volume and session when still valid. A revoked/expired login can require reauthentication; it is not perpetual.
- Never use `docker compose down -v` casually; it removes auth **and database** volumes.
- Use secret/env-file injection for DB/n8n credentials; do not commit real .env files.

## Production boundary

This Compose is a **local/isolated POC**. Port 80 is unencrypted; do not expose real customer OTP, documents or PII publicly without upstream TLS termination. For deployed environments prefer managed identity, pinned container digests/versions, backups, resource limits and observability.

## Required Compose validation

- `docker compose config` passes.
- `docker compose ps` shows only `0.0.0.0:80->80/tcp` published.
- `curl http://localhost/`, `/admin/`, `/api/health` succeed when corresponding implementations exist.
- SSE test shows low-latency streaming through Nginx (proxy buffering disabled).
- Private services do not respond on direct host ports 3000, 4000, 8000, 5432, 5678 or 6379.
- Database, Redis, n8n and Azure CLI cache survive `up -d --build` / restart.
- Invalid Foundry credentials produce an explicit service error, not hallucinated answers.
