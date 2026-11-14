-- Per-agent published action-to-safe-executor registry (no arbitrary URLs).
-- This table is operator-owned: the model and runtime may only SELECT.
BEGIN;
CREATE TABLE agent_action_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  action_key varchar(128) NOT NULL CHECK(action_key ~ '^[a-z][a-z0-9_]{0,127}$'),
  label varchar(200) NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
  execution_kind text NOT NULL CHECK(execution_kind IN
    ('ticket_request','salesforce_lead','quotation','purchase')),
  requires_identity_documents boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,action_key),
  UNIQUE(agent_id,id)
);
CREATE INDEX agent_action_bindings_enabled
  ON agent_action_bindings(agent_id,action_key) WHERE enabled=true;
ALTER TABLE agent_action_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_action_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_action_bindings_agent ON agent_action_bindings
  USING(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
  WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
GRANT SELECT ON agent_action_bindings TO agent_runtime;
-- Preserve ANCFZ POC capabilities with explicitly reviewed handlers.
-- External executor kinds still require their separately configured Node workers.
INSERT INTO agent_action_bindings(agent_id,action_key,label,execution_kind,
  requires_identity_documents,enabled)
SELECT a.id,b.action_key,b.label,b.execution_kind,b.requires_identity,true
FROM agents a CROSS JOIN (VALUES
 ('create_lead','Create Salesforce lead','salesforce_lead',false),
 ('generate_quote','Generate quotation','quotation',false),
 ('purchase_quotation','Purchase quotation','purchase',true),
 ('create_enquiry','Service enquiry','ticket_request',false),
 ('create_renewal_request','Licence renewal request','ticket_request',true),
 ('create_amendment_request','Licence amendment request','ticket_request',true),
 ('create_visa_enquiry','Visa service enquiry','ticket_request',true),
 ('create_referral','Partner referral request','ticket_request',false),
 ('request_specialist_review','Specialist review request','ticket_request',false),
 ('create_support_request','Customer support request','ticket_request',false)
) AS b(action_key,label,execution_kind,requires_identity)
WHERE a.agent_key='ancfz'
ON CONFLICT(agent_id,action_key) DO NOTHING;
COMMIT;
