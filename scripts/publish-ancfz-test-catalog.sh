#!/usr/bin/env bash
# Explicit operator-only TEST publication. Never runs during ordinary API boot.
set -euo pipefail
if [[ "${1:-}" != "--publish-test" ]]; then
  echo "Usage: bash scripts/publish-ancfz-test-catalog.sh --publish-test" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Use the same private .env that Docker Compose uses. Never print secrets.
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi
if [[ "${ANCFZ_CATALOG_ENV:-}" != "test" ]]; then
  echo "Refusing publication without ANCFZ_CATALOG_ENV=test" >&2
  exit 2
fi
: "${POSTGRES_PASSWORD:?Set PostgreSQL owner password in local .env}"
: "${POSTGRES_APP_PASSWORD:?Set restricted PostgreSQL password in local .env}"
: "${FOUNDRY_PROJECT_ENDPOINT:?Set the existing published Foundry project endpoint}"
: "${FOUNDRY_AGENT_NAME:?Set the published Foundry agent name}"
: "${FOUNDRY_AGENT_VERSION:?Set the published Foundry agent version}"

# Uses postgres solely for owner-authorized catalog administration. The Node
# runtime remains agent_runtime (RLS enforced). No database port is published.
docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 \
       --username postgres \
       --dbname "${POSTGRES_DB:-ai_service_agent}" \
       --set=seed_payload="$(cat "$ROOT/infra/catalog/ancfz-test-2026.json")" \
       --set=foundry_endpoint="$FOUNDRY_PROJECT_ENDPOINT" \
       --set=foundry_name="$FOUNDRY_AGENT_NAME" \
       --set=foundry_version="$FOUNDRY_AGENT_VERSION" \
       < "$ROOT/infra/catalog/seed-ancfz-test.sql"
