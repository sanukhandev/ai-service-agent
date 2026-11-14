#!/usr/bin/env bash
# Disposable database only. Never reuses the normal experiment or main volumes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PROJECT=ai-service-agent-gemini-p2-verify
export GEMINI_COMPOSE_PROJECT="$PROJECT"
export POSTGRES_DB=ai_service_agent_gemini_p2_test
export POSTGRES_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export POSTGRES_APP_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export ANCFZ_CATALOG_ENV=test
export GEMINI_MODEL_ID=gemini-2.5-flash
# Environment must not supply usable Foundry bindings to this Gemini bootstrap.
export FOUNDRY_PROJECT_ENDPOINT='' FOUNDRY_AGENT_NAME='' FOUNDRY_AGENT_VERSION=''
# The base compose has fixed named volumes, independent of the project name.
# Override every persistent resource before starting or deleting ANY test container.
OVERRIDE="$(mktemp --suffix=-gemini-p2.yml)"
cat > "$OVERRIDE" <<'YAML'
name: ai-service-agent-gemini-p2-verify
networks:
  frontend:
    name: ai-service-agent-gemini-p2-verify-frontend
  backend:
    name: ai-service-agent-gemini-p2-verify-backend
volumes:
  postgres-data:
    name: ai-service-agent-gemini-p2-verify-postgres-data
  redis-data:
    name: ai-service-agent-gemini-p2-verify-redis-data
  n8n-data:
    name: ai-service-agent-gemini-p2-verify-n8n-data
  azure-cli-auth:
    name: ai-service-agent-gemini-p2-verify-azure-cli-auth
YAML
export GEMINI_COMPOSE_OVERRIDE="$OVERRIDE"
compose() { docker compose -p "$PROJECT" -f "$PWD/docker-compose.yml" -f "$OVERRIDE" "$@"; }
if docker volume inspect "$PROJECT-postgres-data" >/dev/null 2>&1 ||
   docker network inspect "$PROJECT-backend" >/dev/null 2>&1; then
 rm -f "$OVERRIDE"
 echo "Existing P2 disposable resources found; refusing reset" >&2; exit 2
fi
if compose ps --status running --services 2>/dev/null | grep -qx 'postgres'; then
 rm -f "$OVERRIDE"
 echo "Refusing running P2 test database" >&2; exit 2
fi
config="$(compose config)"
for expected in "$PROJECT-postgres-data" "$PROJECT-backend" "$PROJECT-frontend"; do
 if [[ "$config" != *"$expected"* ]]; then
  rm -f "$OVERRIDE"
  echo "Compose resource isolation verification failed" >&2; exit 2
 fi
done
finish() {
 compose down -v --remove-orphans >/dev/null 2>&1 || true
 rm -f "$OVERRIDE"
}
trap finish EXIT
compose up -d --wait postgres
echo 'TEST 1: Fresh migrations and seed without Foundry environment'
compose run --rm migrate
echo 'TEST 2: Repeat migration/seed idempotency'
compose run --rm migrate
echo 'TEST 3: Fail closed on migration checksum change'
tampered="$(mktemp)"
cp infra/postgres/009_gemini_bindings.sql "$tampered"
printf '\n-- checksum-change\n' >> "$tampered"
if compose run --rm \
 -v "$tampered:/migrations/009_gemini_bindings.sql:ro" migrate >/dev/null 2>&1; then
 rm -f "$tampered"; echo "Tampered migration accepted" >&2; exit 1
fi
rm -f "$tampered"
echo 'TEST 4: PostgreSQL approval, RLS and role checks'
compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < infra/postgres/gemini-p2-integration.sql
echo 'TEST 5: Catalog publish and repeat without agent mutation'
before="$(compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" -c "SELECT active_version_id FROM agents WHERE agent_key='ancfz'")"
bash scripts/publish-ancfz-test-catalog.sh --publish-test
bash scripts/publish-ancfz-test-catalog.sh --publish-test
after="$(compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" -c "SELECT active_version_id FROM agents WHERE agent_key='ancfz'")"
test "$before" = "$after"
counts="$(compose exec -T postgres psql -At -F , -U postgres -d "$POSTGRES_DB" -c "
SELECT
(SELECT count(*) FROM intents i JOIN intent_catalog_versions v ON v.id=i.catalog_version_id WHERE v.agent_id=a.id AND v.status='published'),
(SELECT count(*) FROM offerings o JOIN offering_catalog_versions v ON v.id=o.catalog_version_id WHERE v.agent_id=a.id AND v.status='published'),
(SELECT count(*) FROM offering_price_revisions p JOIN offerings o ON o.id=p.offering_id JOIN offering_catalog_versions v ON v.id=o.catalog_version_id WHERE v.agent_id=a.id AND v.status='published'),
(SELECT count(*) FROM ancfz_test_catalog_seed_receipts WHERE agent_id=a.id),
(SELECT count(*) FROM offering_catalog_versions WHERE agent_id=a.id AND status='published' AND source_authority='unapproved')
FROM agents a WHERE a.agent_key='ancfz'")"
test "$counts" = '21,97,55,1,1'
echo 'TEST 6: Node repositories against actual PostgreSQL'
compose build api
compose run --rm -e P2_TEST_DB_ONLY=1 api node --test dist/repositories/gemini.integration.test.js dist/runtime/gemini-api.integration.test.js
echo 'P2 disposable database checks passed'
