-- Stable ANCFZ agreement identity and versioned private contract PDFs.
-- PostgreSQL is authoritative; n8n Data Table receives only reference metadata.
BEGIN;

CREATE SEQUENCE ancfz_agreement_number_seq AS bigint START WITH 1;
GRANT USAGE ON SEQUENCE ancfz_agreement_number_seq TO agent_runtime;

CREATE TABLE service_agreements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  initial_ticket_id uuid NOT NULL,
  initial_payment_id uuid NOT NULL,
  agreement_number varchar(100) NOT NULL
    CHECK(agreement_number ~ '^ANCFZ-AGR-[0-9]{4}-[0-9]{6,}$'),
  current_revision integer NOT NULL DEFAULT 0 CHECK(current_revision>=0),
  sync_state text NOT NULL DEFAULT 'pending'
    CHECK(sync_state IN ('pending','synced','retry','needs_review')),
  sync_attempts smallint NOT NULL DEFAULT 0 CHECK(sync_attempts BETWEEN 0 AND 12),
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,initial_payment_id),
  UNIQUE(agent_id,agreement_number),
  FOREIGN KEY(agent_id,initial_ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,initial_ticket_id,initial_payment_id)
    REFERENCES ticket_payment_attempts(agent_id,ticket_id,id) ON DELETE RESTRICT
);
CREATE INDEX service_agreements_sync_queue ON service_agreements
  (agent_id,next_sync_at,created_at)
  WHERE sync_state IN ('pending','retry');

ALTER TABLE service_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_agreements FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON service_agreements
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON service_agreements TO agent_runtime;
GRANT UPDATE(current_revision,sync_state,sync_attempts,next_sync_at,updated_at)
  ON service_agreements TO agent_runtime;

ALTER TABLE ticket_service_contracts
  ADD COLUMN agreement_id uuid,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
  ADD COLUMN invoice_id uuid;

-- Existing generated/pending test contracts become first revisions; do not
-- mutate their PDFs or earlier document numbers.
INSERT INTO service_agreements(id,agent_id,initial_ticket_id,initial_payment_id,
  agreement_number,current_revision)
SELECT c.id,c.agent_id,c.ticket_id,c.payment_id,
  'ANCFZ-AGR-' || to_char(c.created_at AT TIME ZONE 'UTC','YYYY') ||
  '-' || lpad(nextval('ancfz_agreement_number_seq')::text,6,'0'),
  CASE WHEN c.state='verified_completed' THEN 1 ELSE 0 END
FROM ticket_service_contracts c;

UPDATE ticket_service_contracts c
SET agreement_id=c.id,
    invoice_id=(SELECT i.id FROM ticket_payment_invoices i
       WHERE i.agent_id=c.agent_id AND i.ticket_id=c.ticket_id
         AND i.quotation_id=c.quotation_id AND i.payment_id=c.payment_id
       ORDER BY i.created_at DESC LIMIT 1);
ALTER TABLE ticket_service_contracts ALTER COLUMN agreement_id SET NOT NULL;
ALTER TABLE ticket_service_contracts
  ADD CONSTRAINT ticket_service_contracts_agreement_fk
    FOREIGN KEY(agent_id,agreement_id) REFERENCES service_agreements(agent_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT ticket_service_contracts_invoice_fk
    FOREIGN KEY(agent_id,ticket_id,invoice_id)
      REFERENCES ticket_payment_invoices(agent_id,ticket_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT ticket_service_contracts_agreement_revision_uq
    UNIQUE(agent_id,agreement_id,revision);
CREATE INDEX ticket_service_contracts_agreement_version
  ON ticket_service_contracts(agent_id,agreement_id,revision DESC);

-- No automatic retry of 'needs_review' historical cases: operators may need
-- to resolve mismatched identity evidence before a safe re-render.
COMMIT;
