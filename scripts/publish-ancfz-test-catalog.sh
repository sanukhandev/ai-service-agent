#!/usr/bin/env bash
# Explicit operator-only TEST publication. Never runs during ordinary API boot.
set -euo pipefail
if [[ "${1:-}" != "--publish-test" ]]; then
  echo "Usage: bash scripts/publish-ancfz-test-catalog.sh --publish-test [--catalog=ancfz-test-renewal-2026.json]" >&2
  exit 2
fi
catalog_file="ancfz-test-2026.json"
if [[ "${2:-}" == "--catalog=ancfz-test-renewal-2026.json" ]]; then
  catalog_file="ancfz-test-renewal-2026.json"
elif [[ -n "${2:-}" ]]; then
  echo "Refusing unknown catalog file; select the reviewed test renewal catalog explicitly" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$catalog_file" == "ancfz-test-renewal-2026.json" ]]; then
  # Never publish a supposed priced renewal service with zero approved rates.
  node --input-type=module -e '
    import {readFileSync} from "node:fs";
    const catalog=JSON.parse(readFileSync("infra/catalog/ancfz-test-renewal-2026.json","utf8"));
    const priced=catalog.offerings.filter(x=>x.intentKey==="license_renewal" &&
      x.key.startsWith("renewal_")&&x.price &&
      x.price.currency==="AED"&&Number.isFinite(x.price.amount)&&x.price.amount>0 &&
      typeof x.price.conditions==="string" && x.price.conditions.trim());
    if(priced.length===0) {
      console.error("Blocked: fill at least one owner-approved, versioned TEST renewal offering price and its conditions");
      process.exit(2);
    }
  '
fi

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
#
# Windows / Git Bash cannot pass the ~90 KiB JSON as one docker.exe argument.
# Copy the catalog to the PostgreSQL container and read it server-side.
container_id="$(docker compose ps -q postgres)"
if [[ -z "$container_id" ]]; then
  echo "PostgreSQL service is not running. Start with docker compose up -d." >&2
  exit 1
fi

seed_basename="ancfz-test-seed-$(date +%s)-$$-${RANDOM}.json"
seed_path="/tmp/$seed_basename"
cleanup() {
  MSYS_NO_PATHCONV=1 docker compose exec -T postgres rm -f "$seed_path" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Relative path for Docker Desktop; do not convert the container's /tmp path.
MSYS_NO_PATHCONV=1 docker cp \
  "./infra/catalog/$catalog_file" \
  "${container_id}:${seed_path}"

# Do not depend on NTFS file mode bits.
MSYS_NO_PATHCONV=1 docker compose exec -T postgres chmod 0644 "$seed_path"

# Only short arguments cross Windows -> Docker Desktop. The JSON data remains
# inside Postgres' private container, and is never passed via an environment
# variable or a host process argument.
MSYS_NO_PATHCONV=1 docker compose exec -T postgres \
  psql -v ON_ERROR_STOP=1 \
       --username postgres \
       --dbname "${POSTGRES_DB:-ai_service_agent}" \
       --set=seed_file="$seed_path" \
       --set=foundry_endpoint="$FOUNDRY_PROJECT_ENDPOINT" \
       --set=foundry_name="$FOUNDRY_AGENT_NAME" \
       --set=foundry_version="$FOUNDRY_AGENT_VERSION" \
       < "$ROOT/infra/catalog/seed-ancfz-test.sql"
