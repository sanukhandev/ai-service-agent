-- New commercial transaction per renewal, with the previously paid agreement immutable.
-- No second Salesforce creation. No implicit renewal pricing. Agent isolation via RLS.
BEGIN;
CREATE TABLE ticket_contract_renewals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  source_contract_id uuid NOT NULL,
  contract_number varchar(40) NOT NULL,
  source_revision integer NOT NULL CHECK(source_revision BETWEEN 1 AND 999),
  source_ticket_id uuid NOT NULL,
  renewal_ticket_id uuid NOT NULL,
  request_id uuid NOT NULL,
  offering_key varchar(128) NOT NULL CHECK(offering_key ~ '^renewal_[a-z0-9_]+$'),
  price_revision integer NOT NULL CHECK(price_revision > 0),
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  currency char(3) NOT NULL DEFAULT 'AED' CHECK(currency = 'AED'),
  source_document_sha256 char(64) NOT NULL CHECK(source_document_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,request_id),
  UNIQUE(agent_id,renewal_ticket_id),
  FOREIGN KEY(agent_id,source_contract_id)
    REFERENCES ticket_service_contracts(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,source_ticket_id)
    REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,renewal_ticket_id)
    REFERENCES tickets(agent_id,id) ON DELETE RESTRICT
);
-- A renewal can be pending for only one agreement, regardless of the chosen source revision.
CREATE UNIQUE INDEX ticket_contract_renewals_one_pending
  ON ticket_contract_renewals(agent_id,contract_number) WHERE status='requested';
CREATE INDEX ticket_contract_renewals_history
  ON ticket_contract_renewals(agent_id,contract_number,created_at DESC);
ALTER TABLE ticket_contract_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_contract_renewals FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_contract_renewals
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON ticket_contract_renewals TO agent_runtime;
GRANT UPDATE(status,completed_at) ON ticket_contract_renewals TO agent_runtime;

-- Reject a renewal link crossing a different contract number or version.
ALTER TABLE ticket_service_contracts ADD CONSTRAINT ticket_contract_revision_source_consistent
CHECK (
  (renewal_of_contract_id IS NULL AND agreement_revision=1) OR
  (renewal_of_contract_id IS NOT NULL AND agreement_revision>1)
);
CREATE INDEX ticket_service_contracts_contract_history
  ON ticket_service_contracts(agent_id,contract_number,agreement_revision DESC);
COMMIT;
