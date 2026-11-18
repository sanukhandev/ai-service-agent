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

body=$(printf '{"requestId":"%s","text":"I want to start an IT services company with one visa and shared office. My contact email is demo@example.invalid."}' "$request_id")
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

# A citation in a ticket must not grant an anonymous caller access to that
# ticket or a provider file. Synthetic source exists only in disposable CI.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" <<SQL
UPDATE ticket_messages
SET source_references='[{"sourceId":"file-ci-source-ref","title":"CI synthetic source"}]'::jsonb
WHERE ticket_id='$ticket_id' AND role='customer';
SQL
unauthorized_source=$(curl --silent -o /dev/null -w '%{http_code}' \
  "http://localhost/api/v1/tickets/$ticket_id/sources/file-ci-source-ref/download")
test "$unauthorized_source" = 404
unknown_source=$(curl --silent -o /dev/null -w '%{http_code}' -b "$jar" \
  "http://localhost/api/v1/tickets/$ticket_id/sources/file-not-cited/download")
test "$unknown_source" = 404

stream=$(curl --silent -N --max-time 4 -b "$jar" -H 'Last-Event-ID: 0' \
  "http://localhost/api/events/tickets/$ticket_id" || true)
printf '%s' "$stream" | grep -q 'event: message.accepted'

migrations=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c 'SELECT count(*) FROM public.schema_migrations')
test "$migrations" = 14
# Quote OTP confirmation has separate RLS, distinct from purchase-payment OTP.
quote_confirmation_rls=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_class WHERE relname='ticket_quote_confirmation_otps' AND relrowsecurity AND relforcerowsecurity")
test "$quote_confirmation_rls" = 1
# New OTP/payment/invoice tables must enforce agent-scoped row-level security.
payment_rls=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_class WHERE relname IN ('ticket_payment_otps','ticket_payment_attempts','ticket_payment_invoices') AND relrowsecurity AND relforcerowsecurity")
test "$payment_rls" = 3
# Separate provider payment_id from display RefNo; runtime may update only
# this narrowly granted field and the existing payment state.
provider_id_column=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM information_schema.columns WHERE table_name='ticket_payment_attempts' AND column_name='provider_payment_id'")
test "$provider_id_column" = 1
provider_id_grant=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT has_column_privilege('agent_runtime','ticket_payment_attempts','provider_payment_id','UPDATE')")
test "$provider_id_grant" = t

count=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM ticket_messages WHERE ticket_id='$ticket_id' AND role='customer'")
test "$count" = 1

# Run the real Node intent registry against the same agent-scoped ticket.
# Both source message IDs are persisted through the public API first.
first_id=$(printf '%s' "$first" | python3 -c 'import json,sys;print(json.load(sys.stdin)["messageId"])')
correction_request=$(python3 -c 'import uuid;print(uuid.uuid4())')
correction_body=$(printf '{"requestId":"%s","text":"Correction: I need two visas, not one, and there will be two shareholders."}' "$correction_request")
correction=$(curl --fail --silent --show-error -b "$jar" -H 'Content-Type: application/json' \
  -d "$correction_body" "http://localhost/api/v1/tickets/$ticket_id/messages")
correction_id=$(printf '%s' "$correction" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["status"]=="accepted";print(d["messageId"])')
docker compose exec -T \
  -e P3_OFFLINE_SMOKE=1 \
  -e P3_TEST_TICKET="$ticket_id" \
  -e P3_TEST_MESSAGE1="$first_id" \
  -e P3_TEST_MESSAGE2="$correction_id" \
  api node dist/runtime/intent-smoke.js

# Private operation status requires an authenticated ticket-owner session.
unauthorized_operation=$(curl --silent -o /dev/null -w '%{http_code}' "http://localhost/api/v1/tickets/$ticket_id/operations")
test "$unauthorized_operation" = 404

# Check the customer-facing API's fail-closed state before authorizing the offline operation.
lead_options=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id/operations")
printf '%s' "$lead_options" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["enabled"] is False;assert d["operations"]==[]'
lead_denied=$(curl --silent -o /dev/null -w '%{http_code}' -b "$jar" -H 'Content-Type: application/json' -d '{"requestId":"11111111-1111-4111-8111-111111111111","consent":true}' "http://localhost/api/v1/tickets/$ticket_id/operations/salesforce-lead")
test "$lead_denied" = 400

# Queue one authorized lead through the real restricted database role. The live
# API worker remains disabled, so there is no Salesforce/n8n side effect.
docker compose exec -T \
  -e P4_OFFLINE_SMOKE=1 \
  -e P3_TEST_TICKET="$ticket_id" \
  api node dist/runtime/lead-smoke.js

lead_status=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id/operations")
printf '%s' "$lead_status" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["enabled"] is False;assert len(d["operations"])==1;assert d["operations"][0]["state"]=="queued"'

printf '%s\\n' 'P3/P4 offline integration PASS: guest ticket, SSE, intent tools, consent, dedupe, durable lead queue'
# CI-only price fixture; never use this value as a customer quotation.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" <<'SQL'
INSERT INTO offering_price_revisions(
  agent_id,offering_id,revision,currency,amount,conditions,effective_from
)
SELECT agent_id,id,1,'AED',16200.00,
       'CI synthetic price: never use in customer quotes',now()-interval '1 day'
FROM offerings WHERE offering_key='company_setup_consultation'
  AND agent_id=(SELECT id FROM agents WHERE agent_key='ancfz');
SQL

# The API's provider worker stays off. The independent DB smoke injects a
# synthetic Lead ID into an isolated test ticket and exercises quote gates.
quote_options=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id/quotation-options")
printf '%s' "$quote_options" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["enabled"] is False;assert d["options"]==[]'
docker compose exec -T -e P4_QUOTATION_OFFLINE_SMOKE=1 -e P3_TEST_TICKET="$ticket_id" \
  api node dist/runtime/quotation-smoke.js

private_pdf=$(curl --silent -o /dev/null -w '%{http_code}' \
  "http://localhost/api/v1/tickets/$ticket_id/quotations/33333333-3333-4333-8333-333333333333/pdf")
test "$private_pdf" = 404
quoted=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id/quotations")
printf '%s' "$quoted" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["quotation"]["state"]=="queued";assert d["quotation"]["pdfAvailable"] is False'
printf '%s\n' 'P4 quotation offline DB smoke PASS'
# Confirm v2 intent purchase requirements, owner isolation and document/consent gates.
purchase_rls=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_class WHERE relname IN ('intent_document_requirements','ticket_purchase_documents','ticket_purchase_confirmations') AND relrowsecurity AND relforcerowsecurity")
test "$purchase_rls" = 3
published=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM agents a JOIN intent_catalog_versions v ON v.agent_id=a.id JOIN intents i ON i.agent_id=a.id AND i.catalog_version_id=v.id WHERE a.agent_key='ancfz' AND v.revision=2 AND v.status='published' AND i.intent_key='company_formation' AND 'purchase_quotation'=ANY(i.allowed_actions)")
test "$published" = 1
# Every published ANCFZ intent must have exactly the same 2 required files.
universal_docs=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM agents a JOIN intent_catalog_versions v ON v.agent_id=a.id AND v.status='published' JOIN intents i ON i.agent_id=a.id AND i.catalog_version_id=v.id WHERE a.agent_key='ancfz' AND (SELECT count(*) FROM intent_document_requirements r WHERE r.agent_id=i.agent_id AND r.intent_id=i.id AND r.required AND r.requirement_key IN ('passport','emirates_id'))=2 AND (SELECT count(*) FROM intent_document_requirements r WHERE r.agent_id=i.agent_id AND r.intent_id=i.id)=2")
if [ "$universal_docs" != 4 ]; then
  echo "Universal identity-document policy expected 4 intents, got $universal_docs" >&2
  exit 1
fi
unauthorized_purchase=$(curl --silent -o /dev/null -w '%{http_code}' "http://localhost/api/v1/tickets/$ticket_id/purchase")
test "$unauthorized_purchase" = 404
docker compose exec -T -e P5_PURCHASE_OFFLINE_SMOKE=1 -e P3_TEST_TICKET="$ticket_id" \
  api node dist/runtime/purchase-smoke.js
purchase_status=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$ticket_id/purchase")
printf '%s' "$purchase_status" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["supported"];assert d["readyForOtp"];assert d["confirmed"];assert len(d["requirements"])==2'
# Exercise the quotation read as the REAL restricted runtime role.
# Verified quotations are immutable; preflight must NOT need an UPDATE grant.
# This test executes against the disposable CI database with RLS active.
docker compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" <<SQL
BEGIN;
SELECT set_config('app.agent_id',(SELECT agent_id::text FROM tickets WHERE id='$ticket_id'),true);
SET LOCAL ROLE agent_runtime;
SELECT q.id,q.amount::text,q.currency,op.state,
       EXISTS(SELECT 1 FROM ticket_quotation_pdfs pdf
         WHERE pdf.agent_id=q.agent_id AND pdf.ticket_id=q.ticket_id
           AND pdf.quotation_id=q.id) AS has_pdf
FROM ticket_quotations q
JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.ticket_id=q.ticket_id
  AND op.id=q.operation_id AND op.operation_key='ancfz_render_quote'
WHERE q.agent_id=current_setting('app.agent_id')::uuid
  AND q.ticket_id='$ticket_id'
  AND q.id=(SELECT id FROM ticket_quotations WHERE ticket_id='$ticket_id' LIMIT 1);
ROLLBACK;
SQL
# Contract-level DB execution of every non-provider action in the bootstrap
# catalog, including authorization, fact provenance and durable chat notice.
service_rls=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_class WHERE relname='ticket_service_requests' AND relrowsecurity AND relforcerowsecurity")
test "$service_rls" = 1
docker compose exec -T -e P5_INTENT_ACTION_SMOKE=1 api node dist/runtime/intent-actions-smoke.js


# A forged public merchant callback must never confirm a payment, queue an
# invoice, or require a ticket-owner cookie. It only acknowledges receipt.
mock_notification=$(curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -d '{"MESSAGE_TYPE":"ORDER_CREATED","ORDERSTATUS":"COMPLETE","IPN_TOTAL":"999999.99"}' \
  http://localhost/api/v1/mockgateway/notifications)
printf '%s' "$mock_notification" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d=={"received":True,"paymentVerified":False}'
invoices_after_notification=$(docker compose exec -T postgres psql -At -U postgres -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM ticket_payment_invoices")
test "$invoices_after_notification" = 0

# P5 customer payment routes are still disabled without explicit test-mode flags.
unauthorized_payment=$(curl --silent -o /dev/null -w '%{http_code}' \
  "http://localhost/api/v1/tickets/$ticket_id/payments")
test "$unauthorized_payment" = 404
payment_status=$(curl --fail --silent --show-error -b "$jar" \
  "http://localhost/api/v1/tickets/$ticket_id/payments")
printf '%s' "$payment_status" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d["enabled"] is False;assert d["payments"] == [];assert d["invoice"] is None'
otp_disabled=$(curl --silent -o /dev/null -w '%{http_code}' -b "$jar" \
  -H 'Content-Type: application/json' -d '{}' \
  "http://localhost/api/v1/tickets/$ticket_id/payments/otp")
test "$otp_disabled" = 503
printf '%s\n' 'P5 scoped payment tables and disabled-by-default routes PASS'




# Long-ticket regression: the customer must see the newest 200 messages, with
# authenticated cursor access to older history (not the oldest 200 forever).
history_ticket=$(curl --fail --silent --show-error -b "$jar" -H 'Content-Type: application/json' -d '{}'   http://localhost/api/v1/agents/ancfz/tickets)
history_id=$(printf '%s' "$history_ticket" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB" <<SQL
UPDATE tickets SET last_message_sequence=205 WHERE id='$history_id';
INSERT INTO ticket_messages(agent_id,ticket_id,role,content,request_id,source_references,message_sequence)
SELECT t.agent_id,t.id,'assistant','CI historical message '||n::text,
       gen_random_uuid(),'[]'::jsonb,n
FROM tickets t CROSS JOIN generate_series(1,205) n WHERE t.id='$history_id';
SQL
latest=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$history_id")
printf '%s' "$latest" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert len(d["messages"])==200;assert d["messages"][0]["sequence"]=="6";assert d["messages"][-1]["sequence"]=="205";assert d["hasOlder"]'
older=$(curl --fail --silent --show-error -b "$jar" "http://localhost/api/v1/tickets/$history_id/messages?before=6&limit=100")
printf '%s' "$older" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert [m["sequence"] for m in d["messages"]]==[str(i) for i in range(1,6)];assert not d["hasOlder"]'
denied_older=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost/api/v1/tickets/$history_id/messages?before=6")
test "$denied_older" = 404
printf '%s\n' 'Long-ticket regression PASS: newest-window bootstrap, owner-scoped older pagination'

printf '%s\n' 'Live Foundry and browser certification remain BLOCKED without credentials.'
