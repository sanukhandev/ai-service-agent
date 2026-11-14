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

# Uses postgres solely for owner-authorized catalog administration. The Node
# runtime remains agent_runtime (RLS enforced). No database port is published.
#
# Windows / Git Bash cannot pass the ~90 KiB JSON as one docker.exe argument.
# Copy the catalog to the PostgreSQL container and read it server-side.
container_id="$(docker compose -p ai-service-agent-gemini ps -q postgres)"
if [[ -z "$container_id" ]]; then
  echo "PostgreSQL service is not running. Start with docker compose -p ai-service-agent-gemini up -d." >&2
  exit 1
fi

seed_basename="ancfz-test-seed-$(date +%s)-$$-${RANDOM}.json"
seed_path="/tmp/$seed_basename"
cleanup() {
  MSYS_NO_PATHCONV=1 docker compose -p ai-service-agent-gemini exec -T postgres rm -f "$seed_path" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Relative path for Docker Desktop; do not convert the container's /tmp path.
MSYS_NO_PATHCONV=1 docker cp \
  "./infra/catalog/ancfz-test-2026.json" \
  "${container_id}:${seed_path}"

# Do not depend on NTFS file mode bits.
MSYS_NO_PATHCONV=1 docker compose -p ai-service-agent-gemini exec -T postgres chmod 0644 "$seed_path"

# Only short arguments cross Windows -> Docker Desktop. The JSON data remains
# inside Postgres' private container, and is never passed via an environment
# variable or a host process argument.
MSYS_NO_PATHCONV=1 docker compose -p ai-service-agent-gemini exec -T postgres \
  psql -v ON_ERROR_STOP=1 \
       --username postgres \
       --dbname "${POSTGRES_DB:-ai_service_agent_gemini}" \
       --set=seed_file="$seed_path" \
       < "$ROOT/infra/catalog/seed-ancfz-test.sql"
