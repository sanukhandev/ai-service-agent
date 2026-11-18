-- A renewal is a new ticket/quotation/payment/invoice, but points to one
-- stable agreement master. Owner authorization is enforced by Node before linking.
BEGIN;
CREATE TABLE ticket_renewals(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  source_ticket_id uuid NOT NULL,
  renewal_ticket_id uuid NOT NULL,
  request_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK(source_revision>=1),
  status text NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,request_id),
  UNIQUE(agent_id,renewal_ticket_id),
  FOREIGN KEY(agent_id,agreement_id) REFERENCES service_agreements(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,source_ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,renewal_ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ticket_renewals_one_requested_per_agreement
  ON ticket_renewals(agent_id,agreement_id) WHERE status='requested';
CREATE INDEX ticket_renewals_by_agreement
  ON ticket_renewals(agent_id,agreement_id,created_at DESC);
ALTER TABLE ticket_renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_renewals FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_renewals
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON ticket_renewals TO agent_runtime;
GRANT UPDATE(status,completed_at) ON ticket_renewals TO agent_runtime;
COMMIT;
