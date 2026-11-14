-- Intent-specific purchase requirements and ticket-private evidence.
-- Only catalog-published document types authorize a purchase; file bytes never
-- enter LLM prompts, n8n or public static assets.
BEGIN;
CREATE TABLE intent_document_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  requirement_key varchar(128) NOT NULL CHECK(requirement_key ~ '^[a-z][a-z0-9_]{0,127}$'),
  label text NOT NULL,
  guidance text,
  required boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  FOREIGN KEY(agent_id,intent_id) REFERENCES intents(agent_id,id) ON DELETE RESTRICT,
  UNIQUE(agent_id,intent_id,requirement_key),
  UNIQUE(agent_id,intent_id,id)
);
CREATE INDEX intent_document_requirements_lookup ON intent_document_requirements(agent_id,intent_id,sort_order,requirement_key);

CREATE TABLE ticket_purchase_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  requirement_id uuid NOT NULL,
  file_name varchar(150) NOT NULL,
  content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/png','image/jpeg')),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 100 AND 1048576),
  sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,requirement_id),
  UNIQUE(agent_id,ticket_id,id),
  FOREIGN KEY(agent_id,ticket_id) REFERENCES tickets(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,intent_id,requirement_id)
    REFERENCES intent_document_requirements(agent_id,intent_id,id) ON DELETE RESTRICT
);
CREATE INDEX ticket_purchase_documents_ticket ON ticket_purchase_documents(agent_id,ticket_id,intent_id,created_at);

CREATE TABLE ticket_purchase_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  quotation_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  request_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK(amount > 0),
  currency char(3) NOT NULL,
  consent_text text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,ticket_id,quotation_id),
  UNIQUE(agent_id,ticket_id,request_id),
  FOREIGN KEY(agent_id,ticket_id,quotation_id)
    REFERENCES ticket_quotations(agent_id,ticket_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,intent_id) REFERENCES intents(agent_id,id) ON DELETE RESTRICT
);
CREATE INDEX ticket_purchase_confirmations_ticket ON ticket_purchase_confirmations(agent_id,ticket_id,confirmed_at DESC);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['intent_document_requirements','ticket_purchase_documents','ticket_purchase_confirmations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY agent_scope ON %I USING(agent_id=nullif(current_setting(''app.agent_id'',true),'''')::uuid) WITH CHECK(agent_id=nullif(current_setting(''app.agent_id'',true),'''')::uuid)',tbl);
  END LOOP;
END $$;
GRANT SELECT ON intent_document_requirements TO agent_runtime;
GRANT SELECT,INSERT ON ticket_purchase_documents,ticket_purchase_confirmations TO agent_runtime;
COMMIT;
