-- P4 quotation slice: only after a verified ANCFZ Salesforce Lead.
-- Priced offering snapshots and PDFs are ticket-private, never public URLs.
-- No invoice or payment is authorized by these tables.
BEGIN;

ALTER TABLE ticket_operations
  DROP CONSTRAINT ticket_operations_operation_key_check;
ALTER TABLE ticket_operations
  ADD CONSTRAINT ticket_operations_operation_key_check
    CHECK (operation_key IN ('ancfz_salesforce_lead','ancfz_render_quote'));
ALTER TABLE ticket_operations
  ADD CONSTRAINT ticket_operations_scoped_operation_unique
    UNIQUE(agent_id,ticket_id,id);
ALTER TABLE offering_price_revisions
  ADD CONSTRAINT offering_price_revisions_scoped_id_unique UNIQUE(agent_id,id);

CREATE TABLE ticket_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  price_revision_id uuid NOT NULL,
  price_revision integer NOT NULL CHECK(price_revision>0),
  offering_key varchar(128) NOT NULL,
  offering_label text NOT NULL,
  customer_name varchar(200) NOT NULL,
  salesforce_lead_id text NOT NULL CHECK(salesforce_lead_id ~ '^00Q[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'),
  document_number text NOT NULL CHECK(length(document_number) BETWEEN 10 AND 100),
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  conditions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id),
  UNIQUE(agent_id,ticket_id,id),
  UNIQUE(agent_id,ticket_id,operation_id),
  UNIQUE(agent_id,document_number),
  FOREIGN KEY(agent_id,ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,ticket_id,operation_id)
    REFERENCES ticket_operations(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,offering_id) REFERENCES offerings(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,price_revision_id)
    REFERENCES offering_price_revisions(agent_id,id) ON DELETE RESTRICT
);

CREATE TABLE ticket_quotation_pdfs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 100 AND 5242880),
  sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,quotation_id),
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT
);

CREATE INDEX ticket_quotations_by_agent_ticket
  ON ticket_quotations(agent_id,ticket_id,created_at DESC);

ALTER TABLE ticket_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_quotations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_quotations
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);

ALTER TABLE ticket_quotation_pdfs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_quotation_pdfs FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_scope ON ticket_quotation_pdfs
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);

GRANT SELECT,INSERT ON ticket_quotations,ticket_quotation_pdfs TO agent_runtime;
COMMIT;
