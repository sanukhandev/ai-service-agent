-- Separate OTP gate for approving a verified quotation before private identity intake.
-- Never reuse the purchase/payment OTP; this step makes no payment or provider POST.
BEGIN;
CREATE TABLE ticket_quote_confirmation_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  email text NOT NULL CHECK(length(email) BETWEEN 6 AND 254),
  otp_hmac char(64) NOT NULL CHECK(otp_hmac ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','mock_recorded','verified','failed','expired')),
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  UNIQUE(agent_id,ticket_id,request_id),
  UNIQUE(agent_id,ticket_id,id),
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT
);
CREATE INDEX ticket_quote_confirmation_active ON ticket_quote_confirmation_otps
  (agent_id,ticket_id,quotation_id,created_at DESC);
CREATE UNIQUE INDEX ticket_quote_confirmation_once
  ON ticket_quote_confirmation_otps(agent_id,ticket_id,quotation_id)
  WHERE state='verified';
ALTER TABLE ticket_quote_confirmation_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_quote_confirmation_otps FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_quote_confirmation_otps
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT,INSERT ON ticket_quote_confirmation_otps TO agent_runtime;
GRANT UPDATE(state,failed_attempts,verified_at) ON ticket_quote_confirmation_otps TO agent_runtime;
COMMIT;
