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
if docker compose -p "$PROJECT" ps --status running --services 2>/dev/null | grep -q '^postgres$'; then
 echo "Refusing to alter a running P2 test database" >&2; exit 2
fi
finish() { docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap finish EXIT
docker compose -p "$PROJECT" up -d --wait postgres
echo 'TEST 1: Fresh migrations and seed without Foundry environment'
env -u FOUNDRY_PROJECT_ENDPOINT -u FOUNDRY_AGENT_NAME -u FOUNDRY_AGENT_VERSION \
 docker compose -p "$PROJECT" run --rm migrate
echo 'TEST 2: Repeat migration/seed idempotency'
env -u FOUNDRY_PROJECT_ENDPOINT -u FOUNDRY_AGENT_NAME -u FOUNDRY_AGENT_VERSION \
 docker compose -p "$PROJECT" run --rm migrate
echo 'TEST 3: Fail closed on migration checksum change'
tampered="$(mktemp)"
cp infra/postgres/009_gemini_bindings.sql "$tampered"
printf '\n-- checksum-change\n' >> "$tampered"
if docker compose -p "$PROJECT" run --rm \
 -v "$tampered:/migrations/009_gemini_bindings.sql:ro" migrate >/dev/null 2>&1; then
 rm -f "$tampered"; echo "Tampered migration accepted" >&2; exit 1
fi
rm -f "$tampered"
echo 'TEST 4: PostgreSQL approval, RLS and role checks'
docker compose -p "$PROJECT" exec -T postgres psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < infra/postgres/gemini-p2-integration.sql
echo 'TEST 5: Catalog publish and repeat without agent mutation'
before="$(docker compose -p "$PROJECT" exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" -c "SELECT active_version_id FROM agents WHERE agent_key='ancfz'")"
bash scripts/publish-ancfz-test-catalog.sh --publish-test
bash scripts/publish-ancfz-test-catalog.sh --publish-test
after="$(docker compose -p "$PROJECT" exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" -c "SELECT active_version_id FROM agents WHERE agent_key='ancfz'")"
test "$before" = "$after"
counts="$(docker compose -p "$PROJECT" exec -T postgres psql -At -F , -U postgres -d "$POSTGRES_DB" -c "
SELECT
(SELECT count(*) FROM intents i JOIN intent_catalog_versions v ON v.id=i.catalog_version_id WHERE v.agent_id=a.id AND v.status='published'),
(SELECT count(*) FROM offerings o JOIN offering_catalog_versions v ON v.id=o.catalog_version_id WHERE v.agent_id=a.id AND v.status='published'),
(SELECT count(*) FROM offering_price_revisions p JOIN offerings o ON o.id=p.offering_id JOIN offering_catalog_versions v ON v.id=o.catalog_version_id WHERE v.agent_id=a.id AND v.status='published'),
(SELECT count(*) FROM ancfz_test_catalog_seed_receipts WHERE agent_id=a.id),
(SELECT count(*) FROM offering_catalog_versions WHERE agent_id=a.id AND status='published' AND source_authority='unapproved')
FROM agents a WHERE a.agent_key='ancfz'")"
test "$counts" = '21,97,55,1,1'
echo 'TEST 6: Node repositories against actual PostgreSQL'
docker compose -p "$PROJECT" build api
docker compose -p "$PROJECT" run --rm -e P2_TEST_DB_ONLY=1 api node --test dist/repositories/gemini.integration.test.js
echo 'P2 disposable database checks passed'
