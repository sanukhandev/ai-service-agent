-- P5: ANCFZ sandbox payment/OTP records. Forward only, no existing data reset.
-- No provider claim or customer-supplied boolean can become verified payment.
BEGIN;

CREATE TABLE ticket_payment_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  request_id uuid NOT NULL,
  email text NOT NULL CHECK(length(email) BETWEEN 6 AND 254),
  first_name varchar(100) NOT NULL,
  country_code char(2) NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  currency char(3) NOT NULL,
  otp_hmac char(64) NOT NULL CHECK(otp_hmac ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','mock_recorded','consumed','failed','expired')),
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE(agent_id,ticket_id,request_id),
  UNIQUE(agent_id,ticket_id,id),
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT
);

CREATE INDEX ticket_payment_otps_window ON ticket_payment_otps
  (agent_id,ticket_id,created_at DESC);
CREATE INDEX ticket_payment_otps_active ON ticket_payment_otps
  (agent_id,ticket_id,quotation_id,expires_at)
  WHERE state IN ('pending','mock_recorded');

CREATE TABLE ticket_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  otp_id uuid NOT NULL,
  request_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  external_reference text NOT NULL
    CHECK(external_reference ~ '^ANCFZ-[A-Za-z0-9_-]{8,160}$'),
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  currency char(3) NOT NULL,
  first_name varchar(100) NOT NULL,
  email text NOT NULL,
  country_code char(2) NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','creating','checkout_available','order_created_checkout_unavailable',
      'unknown_outcome','verifying','payment_pending','payment_declined','payment_refunded',
      'verified_test_payment','terminal_failed')),
  order_reference text CHECK(order_reference IS NULL OR length(order_reference) BETWEEN 1 AND 120),
  checkout_url text CHECK(checkout_url IS NULL OR (length(checkout_url) <= 2048 AND
    checkout_url LIKE 'https://mockgateway.com/pg/pay/%')),
  provider_status text,
  verification_started_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,quotation_id),
  UNIQUE(agent_id,ticket_id,request_id),
  UNIQUE(agent_id,ticket_id,id),
  UNIQUE(agent_id,external_reference),
  UNIQUE(agent_id,order_reference),
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,otp_id)
    REFERENCES ticket_payment_otps(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,outbox_id)
    REFERENCES event_outbox(agent_id,ticket_id,id) ON DELETE RESTRICT
);

CREATE INDEX ticket_payment_attempts_claim ON ticket_payment_attempts
  (agent_id,state,created_at) WHERE state IN ('queued','creating','verifying');
CREATE INDEX ticket_payment_attempts_customer ON ticket_payment_attempts
  (agent_id,ticket_id,created_at DESC);

CREATE TABLE ticket_payment_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  document_number varchar(100) NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','verified_completed','unknown_outcome')),
  bytes bytea CHECK(bytes IS NULL OR octet_length(bytes) BETWEEN 100 AND 5242880),
  sha256 char(64) CHECK(sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,payment_id),
  UNIQUE(agent_id,ticket_id,quotation_id),
  UNIQUE(agent_id,document_number),
  FOREIGN KEY(agent_id,ticket_id,payment_id)
    REFERENCES ticket_payment_attempts(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,outbox_id)
    REFERENCES event_outbox(agent_id,ticket_id,id) ON DELETE RESTRICT
);

CREATE INDEX ticket_payment_invoices_claim ON ticket_payment_invoices
  (agent_id,state,created_at) WHERE state IN ('queued','running');

-- Enforce existing agent-derived RLS for all newly introduced business state.
ALTER TABLE ticket_payment_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_payment_otps FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_payment_otps
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);

ALTER TABLE ticket_payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_payment_attempts
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);

ALTER TABLE ticket_payment_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_payment_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_payment_invoices
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);

GRANT SELECT,INSERT ON ticket_payment_otps,ticket_payment_attempts,ticket_payment_invoices TO agent_runtime;
GRANT UPDATE(state,failed_attempts,consumed_at) ON ticket_payment_otps TO agent_runtime;
GRANT UPDATE(state,order_reference,checkout_url,provider_status,verification_started_at,
  verified_at,updated_at) ON ticket_payment_attempts TO agent_runtime;
GRANT UPDATE(state,bytes,sha256,updated_at) ON ticket_payment_invoices TO agent_runtime;
COMMIT;
