-- Durable contract identity independent of individual quote/invoice numbers.
-- Existing signed-off demo PDFs remain immutable; populate a clean registry
-- number for each existing contract without altering its source records.
BEGIN;
CREATE SEQUENCE ancfz_service_contract_number_seq START WITH 1;
ALTER TABLE ticket_service_contracts
  ADD COLUMN contract_number varchar(40),
  ADD COLUMN agreement_revision integer NOT NULL DEFAULT 1
    CHECK (agreement_revision BETWEEN 1 AND 1000),
  ADD COLUMN renewal_of_contract_id uuid,
  ADD COLUMN failure_code varchar(80),
  ADD COLUMN registry_sync_state text NOT NULL DEFAULT 'pending'
    CHECK (registry_sync_state IN ('pending','synced'));
ALTER TABLE ticket_service_contracts
  ADD CONSTRAINT ticket_contracts_agent_id_id_unique UNIQUE(agent_id,id);
ALTER TABLE ticket_service_contracts
  ADD CONSTRAINT ticket_contracts_renewal_fk
    FOREIGN KEY(agent_id,renewal_of_contract_id)
      REFERENCES ticket_service_contracts(agent_id,id) ON DELETE RESTRICT;
WITH refs AS (
  SELECT id,
    'ANCFZ-SC-' || to_char(created_at AT TIME ZONE 'UTC','YYYY') ||
    '-' || lpad(nextval('ancfz_service_contract_number_seq')::text,6,'0') AS ref
  FROM ticket_service_contracts ORDER BY created_at,id
)
UPDATE ticket_service_contracts c SET contract_number=refs.ref
FROM refs WHERE c.id=refs.id;
ALTER TABLE ticket_service_contracts ALTER COLUMN contract_number SET NOT NULL;
ALTER TABLE ticket_service_contracts ALTER COLUMN contract_number SET DEFAULT
  'ANCFZ-SC-' || to_char(now() AT TIME ZONE 'UTC','YYYY') ||
  '-' || lpad(nextval('ancfz_service_contract_number_seq')::text,6,'0');
CREATE UNIQUE INDEX ticket_contracts_number_revision_unique
  ON ticket_service_contracts(agent_id,contract_number,agreement_revision);
CREATE INDEX ticket_contracts_sync_pending
  ON ticket_service_contracts(agent_id,created_at)
  WHERE state='verified_completed' AND registry_sync_state='pending';
GRANT USAGE ON SEQUENCE ancfz_service_contract_number_seq TO agent_runtime;
GRANT UPDATE(failure_code,registry_sync_state) ON ticket_service_contracts TO agent_runtime;
COMMIT;
