#!/usr/bin/env bash
# P0 verification only: start minimal containers, verify schema/runtime role
# and both public ingress routes. No customer data, Foundry or n8n actions.
set -euo pipefail

: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}"
: "${POSTGRES_APP_PASSWORD:?Set POSTGRES_APP_PASSWORD}"
if [[ "$POSTGRES_PASSWORD" == "$POSTGRES_APP_PASSWORD" ]]; then
  echo "Migration owner and runtime database passwords must be different" >&2
  exit 1
fi

docker compose config --quiet
docker compose up -d --build postgres redis api web nginx

printf '%s\n' "Checking http://localhost/api/health..."
curl --fail --silent --show-error \
  --retry 30 --retry-connrefused --retry-delay 2 \
  http://localhost/api/health | grep -q '"status":"ok"'

printf '%s\n' "Checking Next.js through Nginx..."
curl --fail --silent --show-error \
  --retry 30 --retry-connrefused --retry-delay 2 \
  http://localhost/ | grep -q 'Sara'

printf '%s\n' "Checking fresh schema and restricted runtime DB role..."
docker compose exec -T postgres sh -ec '
  PGPASSWORD="$POSTGRES_APP_PASSWORD" psql \
    -h 127.0.0.1 -U agent_runtime -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -tAc \
    "SELECT CASE WHEN current_user = '\''agent_runtime'\''
       AND (SELECT rolbypassrls = false AND rolsuper = false
            FROM pg_roles WHERE rolname = current_user)
       AND (SELECT count(*) = 2 FROM pg_tables WHERE schemaname = '\''public'\'' AND tablename IN ('\''agents'\'','\''ticket_facts'\''))
       THEN '\''PASS'\'' ELSE '\''FAIL'\'' END"
' | grep -q 'PASS'

echo "P0 smoke PASS (Node health, Next.js, Postgres schema and non-bypass runtime role)"
