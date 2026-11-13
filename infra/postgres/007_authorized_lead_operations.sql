-- P4 first slice: consented ANCFZ Salesforce lead submissions, never automatic.
-- A provider timeout is NOT evidence of completion. Preserve durable uncertain outcomes.
BEGIN;
ALTER TABLE event_outbox
  ADD CONSTRAINT event_outbox_scoped_operation_fk UNIQUE(agent_id,ticket_id,id);

CREATE TABLE ticket_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (operation_key = 'ancfz_salesforce_lead'),
  payload_digest char(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','verified_completed','unknown_outcome','terminal_failed')),
  provider_reference text,
  provider_status text,
  consented_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,operation_key),
  UNIQUE(agent_id,outbox_id),
  FOREIGN KEY(agent_id,ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,outbox_id)
    REFERENCES event_outbox(agent_id,ticket_id,id) ON DELETE RESTRICT
);

CREATE INDEX ticket_operations_agent_state
  ON ticket_operations(agent_id,state,consented_at) WHERE state IN ('queued','running');

ALTER TABLE ticket_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_operations
  USING (agent_id = nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK (agent_id = nullif(current_setting('app.agent_id',true),'')::uuid);

GRANT SELECT,INSERT ON ticket_operations TO agent_runtime;
GRANT UPDATE (state,provider_reference,provider_status,updated_at)
  ON ticket_operations TO agent_runtime;
-- Outbox status updates are limited to the internal dispatcher, never model tools.
GRANT UPDATE (status,attempts,lease_until) ON event_outbox TO agent_runtime;
COMMIT;
