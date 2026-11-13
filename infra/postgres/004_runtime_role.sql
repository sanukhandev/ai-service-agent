-- Align new persistence privileges with P0's existing restricted login.
-- P0 bootstrap (infra/bootstrap/003-app-runtime-role.sh) already creates
-- agent_runtime with LOGIN, NOSUPERUSER and NOBYPASSRLS.
-- This migration is the ONE source of fine-grained runtime table grants.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_runtime'
    AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'P0 agent_runtime role is missing or unsafe; apply foundation bootstrap first';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO agent_runtime;

-- P0 grants broad writes for the bootstrap tables. Reduce those privileges
-- to the actual operations implemented by the persistence repositories.
REVOKE ALL ON agent_accounts, guest_sessions, tickets, ticket_messages,
  ticket_events, ticket_summaries, ticket_intents, ticket_facts,
  ticket_fact_events, event_outbox FROM agent_runtime;

GRANT SELECT ON agent_versions, agent_accounts, guest_sessions, tickets,
  ticket_messages, ticket_events, ticket_summaries, intent_catalog_versions,
  intents, intent_requirements, offering_catalog_versions, offerings,
  offering_price_revisions, ticket_intents, ticket_facts, ticket_fact_events,
  event_outbox TO agent_runtime;

GRANT INSERT ON guest_sessions, tickets, ticket_messages, ticket_events,
  ticket_summaries, ticket_intents, ticket_facts, ticket_fact_events,
  event_outbox TO agent_runtime;

GRANT UPDATE (status, subject, updated_at, closed_at, account_id,
  guest_session_id, last_event_sequence, last_message_sequence)
  ON tickets TO agent_runtime;
GRANT UPDATE (status, selected_at) ON ticket_intents TO agent_runtime;
GRANT UPDATE (value, verification_status, source_message_id, updated_at)
  ON ticket_facts TO agent_runtime;
GRANT UPDATE (status, attempts, available_at, lease_until)
  ON event_outbox TO agent_runtime;

GRANT USAGE ON SEQUENCE ticket_number_seq TO agent_runtime;

-- RLS policies remain enabled and FORCE'd. The application must set a
-- server-authorized transaction-local app.agent_id before scoped SQL.
COMMIT;
