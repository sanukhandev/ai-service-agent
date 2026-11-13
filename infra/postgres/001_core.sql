-- AI Service Agent: fresh PostgreSQL 16 POC baseline.
-- Apply once to a disposable/fresh database using a migration owner.
-- Do not import legacy agentic-rag-ai migrations or pgvector.
-- Agent-level RLS requires a runtime role that does not bypass policies.
BEGIN;

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key varchar(64) NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_key_format CHECK (agent_key ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE TABLE agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  foundry_project_endpoint text NOT NULL,
  foundry_agent_name text NOT NULL,
  foundry_agent_version text NOT NULL,
  knowledge_binding_ref text,
  persona_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, version_number)
);

ALTER TABLE agents
  ADD COLUMN active_version_id uuid,
  ADD CONSTRAINT agents_active_version_fk
    FOREIGN KEY (id, active_version_id)
    REFERENCES agent_versions(agent_id, id)
    ON DELETE RESTRICT;

CREATE TABLE agent_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  normalized_email text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, normalized_email),
  CHECK (normalized_email = lower(btrim(normalized_email)))
);

CREATE TABLE guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, token_hash)
);

CREATE SEQUENCE ticket_number_seq AS bigint START WITH 1;

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  agent_version_id uuid NOT NULL,
  guest_session_id uuid,
  account_id uuid,
  ticket_number bigint NOT NULL DEFAULT nextval('ticket_number_seq'),
  subject text NOT NULL DEFAULT 'New enquiry',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_customer', 'processing', 'closed')),
  last_event_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, ticket_number),
  FOREIGN KEY (agent_id, agent_version_id)
    REFERENCES agent_versions(agent_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, guest_session_id)
    REFERENCES guest_sessions(agent_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, account_id)
    REFERENCES agent_accounts(agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT tickets_owner_present
    CHECK (guest_session_id IS NOT NULL OR account_id IS NOT NULL)
);

CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('customer', 'assistant')),
  content text NOT NULL CHECK (char_length(content) > 0),
  request_id uuid,
  source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, id),
  FOREIGN KEY (agent_id, ticket_id)
    REFERENCES tickets(agent_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ticket_message_request_dedupe
  ON ticket_messages(agent_id, ticket_id, request_id)
  WHERE request_id IS NOT NULL AND role = 'customer';

CREATE TABLE ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, ticket_id, sequence),
  FOREIGN KEY (agent_id, ticket_id)
    REFERENCES tickets(agent_id, id) ON DELETE RESTRICT
);

CREATE TABLE ticket_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, ticket_id, revision),
  FOREIGN KEY (agent_id, ticket_id)
    REFERENCES tickets(agent_id, id) ON DELETE RESTRICT
);

CREATE TABLE event_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'completed', 'retryable_failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, ticket_id)
    REFERENCES tickets(agent_id, id) ON DELETE RESTRICT
);

-- Indexes correspond to the initial ticket/conversation and outbox access paths.
CREATE INDEX tickets_agent_status_updated
  ON tickets(agent_id, status, updated_at DESC);
CREATE INDEX tickets_agent_account_created
  ON tickets(agent_id, account_id, created_at DESC);
CREATE INDEX ticket_messages_history
  ON ticket_messages(agent_id, ticket_id, created_at, id);
CREATE INDEX outbox_pending_claim
  ON event_outbox(available_at, id)
  WHERE status IN ('pending', 'retryable_failed');
CREATE INDEX guest_sessions_expiry ON guest_sessions(expires_at);

-- Require an authorized agent scope before accessing agent-owned data.
-- Node must SET LOCAL app.agent_id = '<uuid>' inside each scoped transaction.
-- Do not run the application using a superuser or BYPASSRLS role.
-- The public agent alias resolver reads the minimal agents table, then establishes scope.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'agent_versions', 'agent_accounts', 'guest_sessions', 'tickets',
    'ticket_messages', 'ticket_events', 'ticket_summaries', 'event_outbox'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY agent_scope ON %I USING (agent_id = nullif(current_setting(''app.agent_id'', true), '''')::uuid) WITH CHECK (agent_id = nullif(current_setting(''app.agent_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
