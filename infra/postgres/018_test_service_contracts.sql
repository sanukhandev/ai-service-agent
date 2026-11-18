-- Private, nonbinding ANCFZ sandbox service agreements generated only
-- after independently verified mock payment and explicit ID-copy inclusion consent.
BEGIN;
CREATE TABLE ticket_service_contracts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  document_number varchar(100) NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','verified_completed','needs_review')),
  render_attempts smallint NOT NULL DEFAULT 0 CHECK(render_attempts BETWEEN 0 AND 3),
  bytes bytea CHECK(bytes IS NULL OR octet_length(bytes) BETWEEN 100 AND 15728640),
  sha256 char(64) CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,payment_id),
  UNIQUE(agent_id,document_number),
  UNIQUE(agent_id,ticket_id,id),
  FOREIGN KEY(agent_id,ticket_id,payment_id)
    REFERENCES ticket_payment_attempts(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT
);
CREATE INDEX ticket_service_contracts_queue
  ON ticket_service_contracts(agent_id,state,created_at) WHERE state IN ('queued','running');
ALTER TABLE ticket_service_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_service_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_service_contracts
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON ticket_service_contracts TO agent_runtime;
GRANT UPDATE(state,render_attempts,bytes,sha256,updated_at)
  ON ticket_service_contracts TO agent_runtime;
COMMIT;
