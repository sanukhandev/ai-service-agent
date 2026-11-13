-- Apply after 001-003 as database migration owner, never as application runtime.
-- The NOLOGIN privilege group does not contain a password or authentication shortcut.
-- An operator must create a distinct LOGIN role with a securely provisioned password,
-- GRANT ai_service_runtime TO <login_role>, and use that login in DATABASE_URL.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_service_runtime') THEN
    CREATE ROLE ai_service_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ai_service_runtime;
GRANT SELECT (id, agent_key, display_name, status, active_version_id, created_at, updated_at)
  ON agents TO ai_service_runtime;
GRANT SELECT ON agent_versions, agent_accounts, guest_sessions, tickets,
  ticket_messages, ticket_events, ticket_summaries, intent_catalog_versions,
  intents, intent_requirements, offering_catalog_versions, offerings,
  offering_price_revisions, ticket_intents, ticket_facts, ticket_fact_events,
  event_outbox TO ai_service_runtime;

GRANT INSERT ON guest_sessions, tickets, ticket_messages, ticket_events,
  ticket_summaries, ticket_intents, ticket_facts, ticket_fact_events,
  event_outbox TO ai_service_runtime;

GRANT UPDATE (status, subject, updated_at, closed_at, account_id,
  guest_session_id, last_event_sequence, last_message_sequence)
  ON tickets TO ai_service_runtime;
GRANT UPDATE (status, selected_at) ON ticket_intents TO ai_service_runtime;
GRANT UPDATE (value, verification_status, source_message_id, updated_at)
  ON ticket_facts TO ai_service_runtime;
GRANT UPDATE (status, attempts, available_at, lease_until)
  ON event_outbox TO ai_service_runtime;

GRANT USAGE ON SEQUENCE ticket_number_seq TO ai_service_runtime;

-- Permission to read/write a table is not permission to bypass its forced RLS.
-- Runtime must always use a trusted SET LOCAL app.agent_id within a transaction.
COMMIT;
