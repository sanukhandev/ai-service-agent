-- Repeatable post-agent-bootstrap binding for ANCFZ. Operator-only execution.
-- The numbered schema migration may predate creation of the Sara agent.
BEGIN;
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
