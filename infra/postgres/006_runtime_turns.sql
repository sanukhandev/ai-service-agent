-- P3: durable turns, worker leases and narrow guest-session resolution.
-- Migration 006 runs with migration-owner privileges, after 005.
BEGIN;

-- Foundry Responses uses a previous-response cursor, not a fabricated conversation ID.
ALTER TABLE ticket_model_sessions DROP COLUMN external_conversation_id;

CREATE TABLE ticket_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  customer_message_id uuid NOT NULL,
  request_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'processing', 'completed', 'failed', 'uncertain')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_until timestamptz,
  lease_token uuid,
  provider_response_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, ticket_id, customer_message_id),
  UNIQUE (agent_id, ticket_id, request_id),
  FOREIGN KEY (agent_id, ticket_id) REFERENCES tickets(agent_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, ticket_id, customer_message_id)
    REFERENCES ticket_messages(agent_id, ticket_id, id) ON DELETE RESTRICT
);

CREATE INDEX ticket_turns_claim ON ticket_turns(agent_id, state, created_at, id)
  WHERE state IN ('queued', 'processing');
CREATE INDEX ticket_turns_ticket_order ON ticket_turns(agent_id, ticket_id, created_at, id);

ALTER TABLE ticket_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_turns
  USING (agent_id = nullif(current_setting('app.agent_id', true), '')::uuid)
  WITH CHECK (agent_id = nullif(current_setting('app.agent_id', true), '')::uuid);

GRANT SELECT, INSERT ON ticket_turns TO agent_runtime;
GRANT UPDATE (state, attempt_count, lease_until, lease_token, provider_response_id, error_code, updated_at)
  ON ticket_turns TO agent_runtime;

-- A bearer token never authorizes an agent by itself: it first resolves the
-- agent scope, then the ticket repository independently verifies ownership.
-- Definer is the trusted migration owner; do not grant table bypass privileges.
CREATE FUNCTION public.resolve_guest_agent(p_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.agent_id FROM public.guest_sessions AS s
  WHERE s.token_hash = p_hash AND s.expires_at > now()
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.resolve_guest_agent(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_guest_agent(text) TO agent_runtime;

COMMIT;
