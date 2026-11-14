-- Model-proposed actions are durable, inert ticket suggestions. NEVER an outbox.
BEGIN;
CREATE TABLE ticket_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  action_key varchar(128) NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_]{0,127}$'),
  state text NOT NULL DEFAULT 'awaiting_customer_authorization'
    CHECK (state = 'awaiting_customer_authorization'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id,ticket_id,source_message_id,action_key),
  UNIQUE (agent_id,ticket_id,id),
  FOREIGN KEY (agent_id,ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id,intent_id) REFERENCES intents(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id,ticket_id,source_message_id)
    REFERENCES ticket_messages(agent_id,ticket_id,id) ON DELETE RESTRICT
);
CREATE INDEX ticket_action_proposals_history
  ON ticket_action_proposals(agent_id,ticket_id,created_at DESC);
ALTER TABLE ticket_action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_action_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_action_proposals_agent ON ticket_action_proposals
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON ticket_action_proposals TO agent_runtime;
COMMIT;
