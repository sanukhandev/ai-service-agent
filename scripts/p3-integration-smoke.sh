#!/usr/bin/env bash
# Offline P3 integration smoke. Azure credentials intentionally absent.
set -euo pipefail
: "${POSTGRES_PASSWORD:?}"
: "${POSTGRES_APP_PASSWORD:?}"
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

ticket_json=$(curl --fail --silent --show-error -c "$jar" \
  -H 'Content-Type: application/json' -d '{}' \
  http://localhost/api/v1/agents/ancfz/tickets)
ticket_id=$(printf '%s' "$ticket_json" | python3 -c 'import json,sys; d=json.load(sys.stdin);assert d["agentKey"]=="ancfz";print(d["id"])')
request_id=$(python3 -c 'import uuid; print(uuid.uuid4())')

body=$(printf '{"requestId":"%s","text":"I want to start an IT services company with one visa and shared office."}' "$request_id")
first=$(curl --fail --silent --show-error -b "$jar" -H 'Content-Type: application/json' \
  -d "$body" "http://localhost/api/v1/tickets/$ticket_id/messages")
again=$(curl --fail --silent --show-error -b "$jar" -H 'Content-Type: application/json' \
  -d "$body" "http://localhost/api/v1/tickets/$ticket_id/messages")
printf '%s' "$first" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["status"]=="accepted";assert d["messageId"]'
test "$first" = "$again"

history=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id")
printf '%s' "$history" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["ticket"]["agentKey"]=="ancfz";assert len([m for m in d["messages"] if m["role"]=="customer"])==1'
unauthorized=$(curl --silent -o /dev/null -w '%{http_code}' "http://localhost/api/v1/tickets/$ticket_id")
test "$unauthorized" = 404

stream=$(curl --silent -N --max-time 4 -b "$jar" -H 'Last-Event-ID: 0' \
  "http://localhost/api/events/tickets/$ticket_id" || true)
printf '%s' "$stream" | grep -q 'event: message.accepted'

migrations=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c 'SELECT count(*) FROM public.schema_migrations')
test "$migrations" = 5
count=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM ticket_messages WHERE ticket_id='$ticket_id' AND role='customer'")
test "$count" = 1

# Run the real Node intent registry against the same agent-scoped ticket.
# Both source message IDs are persisted through the public API first.
first_id=$(printf '%s' "$first" | python3 -c 'import json,sys;print(json.load(sys.stdin)["messageId"])')
correction_request=$(python3 -c 'import uuid;print(uuid.uuid4())')
correction_body=$(printf '{"requestId":"%s","text":"Correction: I need two visas, not one."}' "$correction_request")
correction=$(curl --fail --silent --show-error -b "$jar" -H 'Content-Type: application/json' \
  -d "$correction_body" "http://localhost/api/v1/tickets/$ticket_id/messages")
correction_id=$(printf '%s' "$correction" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["status"]=="accepted";print(d["messageId"])')
docker compose exec -T \
  -e P3_OFFLINE_SMOKE=1 \
  -e P3_TEST_TICKET="$ticket_id" \
  -e P3_TEST_MESSAGE1="$first_id" \
  -e P3_TEST_MESSAGE2="$correction_id" \
  api node dist/runtime/intent-smoke.js

printf '%s\n' 'P3 offline integration smoke PASS: guest session, ticket, 202, dedupe, ownership, SSE, ledger'
# The P4 API must reject lead submission without explicit form consent.
lead_options=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id/operations")
printf '%s' "$lead_options" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["enabled"] is False;assert d["operations"]==[]'
lead_denied=$(curl --silent -o /dev/null -w '%{http_code}' -b "$jar" -H 'Content-Type: application/json' -d '{"requestId":"11111111-1111-4111-8111-111111111111","consent":true}' "http://localhost/api/v1/tickets/$ticket_id/operations/salesforce-lead")
test "$lead_denied" = 400

printf '%s\n' 'Live Foundry and browser certification remain BLOCKED without credentials.'
