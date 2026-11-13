#!/bin/sh
# Runs only during fresh PGDATA initialization in the official Postgres image.
set -eu

: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD must be set}"
: "${POSTGRES_DB:?POSTGRES_DB must be set}"
: "${POSTGRES_USER:?POSTGRES_USER must be set}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE agent_runtime LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_runtime')
\gexec

ALTER ROLE agent_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
SELECT format('ALTER ROLE agent_runtime PASSWORD %L', :'app_password')
\gexec

GRANT USAGE ON SCHEMA public TO agent_runtime;
GRANT SELECT ON
  agents, agent_versions,
  intent_catalog_versions, intents, intent_requirements,
  offering_catalog_versions, offerings, offering_price_revisions
TO agent_runtime;
GRANT SELECT, INSERT, UPDATE ON
  agent_accounts, guest_sessions,
  tickets, ticket_messages, ticket_events, ticket_summaries,
  ticket_intents, ticket_facts, ticket_fact_events, event_outbox
TO agent_runtime;
GRANT USAGE, SELECT ON SEQUENCE ticket_number_seq TO agent_runtime;
SQL

echo "Created restricted agent_runtime role and scoped table grants"
