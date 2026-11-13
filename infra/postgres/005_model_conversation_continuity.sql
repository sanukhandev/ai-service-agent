-- Durable provider conversation binding; no model invocation or SDK dependency.
-- Apply after 004 as migration owner. One provider conversation per ticket.
BEGIN;

CREATE TABLE ticket_model_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  external_conversation_id text NOT NULL
    CHECK (length(btrim(external_conversation_id)) BETWEEN 1 AND 1024),
  last_response_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, ticket_id, provider),
  FOREIGN KEY (agent_id, ticket_id)
    REFERENCES tickets(agent_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, agent_version_id)
    REFERENCES agent_versions(agent_id, id) ON DELETE RESTRICT,
  CHECK (last_response_id IS NULL OR length(btrim(last_response_id)) BETWEEN 1 AND 1024)
);

ALTER TABLE ticket_model_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_model_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_model_sessions
  USING (agent_id = nullif(current_setting('app.agent_id', true), '')::uuid)
  WITH CHECK (agent_id = nullif(current_setting('app.agent_id', true), '')::uuid);

GRANT SELECT, INSERT ON ticket_model_sessions TO agent_runtime;
GRANT UPDATE (last_response_id, updated_at)
  ON ticket_model_sessions TO agent_runtime;

COMMIT;
