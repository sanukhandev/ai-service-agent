-- ANCFZ POC licence-renewal lookup snapshot and explicit customer acknowledgment.
-- Read-only n8n Data Table is source of licence status; PostgreSQL alone governs
-- ticket ownership, customer confirmation and audit. No licence is renewed by
-- finding it, acknowledging it, quoting, or receiving a sandbox payment.
BEGIN;

CREATE TABLE ticket_licence_renewals (
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  licence_number varchar(64) NOT NULL,
  company_name varchar(200) NOT NULL,
  licence_status varchar(32) NOT NULL
    CHECK (licence_status IN ('active','expired','suspended','cancelled')),
  expires_on date NOT NULL,
  renewal_offering_key varchar(128) NOT NULL
    CHECK (renewal_offering_key ~ '^renewal_[a-z0-9_]{1,110}$'),
  renewal_term_years integer NOT NULL CHECK (renewal_term_years BETWEEN 1 AND 5),
  source_fingerprint char(64) NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
  state varchar(32) NOT NULL DEFAULT 'awaiting_confirmation'
    CHECK (state IN ('awaiting_confirmation','confirmed')),
  looked_up_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_request_id uuid,
  PRIMARY KEY (agent_id,ticket_id),
  FOREIGN KEY (agent_id,ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  CHECK((state='confirmed')=(confirmed_at IS NOT NULL AND confirmed_request_id IS NOT NULL)),
  UNIQUE(agent_id,ticket_id,confirmed_request_id)
);

CREATE INDEX ticket_licence_renewals_lookup
  ON ticket_licence_renewals(agent_id,licence_number,looked_up_at DESC);
ALTER TABLE ticket_licence_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_licence_renewals FORCE ROW LEVEL SECURITY;
CREATE POLICY ticket_licence_renewals_agent ON ticket_licence_renewals
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON ticket_licence_renewals TO agent_runtime;
COMMIT;
