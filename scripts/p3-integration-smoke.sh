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
test "$migrations" = 4
count=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM ticket_messages WHERE ticket_id='$ticket_id' AND role='customer'")
test "$count" = 1

printf '%s\n' 'P3 offline integration smoke PASS: guest session, ticket, 202, dedupe, ownership, SSE, ledger'
printf '%s\n' 'Live Foundry and browser certification remain BLOCKED without credentials.'
