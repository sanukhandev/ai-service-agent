-- POC bootstrap only: Sara / ANCFZ is initial data, never hardcoded runtime logic.
-- Execute as migration owner. Existing published records are never overwritten.
BEGIN;

INSERT INTO agents(agent_key, display_name, status)
VALUES ('ancfz', 'Sara', 'active')
ON CONFLICT (agent_key) DO NOTHING;

INSERT INTO agent_versions(
  agent_id, version_number, foundry_project_endpoint, foundry_agent_name,
  foundry_agent_version, persona_config, published_at
)
SELECT id, 1, :'foundry_endpoint', :'foundry_name', :'foundry_version',
       '{"name":"Sara","tone":"professional","toolNames":["find_intents","select_ticket_intent","get_intent_requirements","record_ticket_facts","get_offerings"]}'::jsonb,
       now()
FROM agents WHERE agent_key = 'ancfz'
ON CONFLICT (agent_id, version_number) DO NOTHING;

UPDATE agents a
SET active_version_id = v.id
FROM agent_versions v
WHERE a.id = v.agent_id AND a.agent_key = 'ancfz'
  AND a.active_version_id IS NULL AND v.version_number = 1;

INSERT INTO intent_catalog_versions(agent_id, revision, status, published_at)
SELECT id, 1, 'published', now() FROM agents WHERE agent_key = 'ancfz'
ON CONFLICT (agent_id, revision) DO NOTHING;

INSERT INTO offering_catalog_versions(agent_id, revision, status, published_at)
SELECT id, 1, 'published', now() FROM agents WHERE agent_key = 'ancfz'
ON CONFLICT (agent_id, revision) DO NOTHING;

WITH data(intent_key, name, description, examples, allowed_actions) AS (
  VALUES
  ('company_formation','Start a Company','Assist with company formation, business activities, visas and workspace.',
    ARRAY['I want to start a company','Register my IT services business','Business licence']::text[],
    ARRAY['create_lead','generate_quote']::text[]),
  ('visa_services','Visa Services','Explain visa-related services and assist with an authorized enquiry.',
    ARRAY['I need a residency visa','Employee visa application']::text[],
    ARRAY['create_enquiry']::text[]),
  ('license_renewal','License Renewal','Explain company licence renewal requirements.',
    ARRAY['Renew my company license','Licence renewal']::text[],
    ARRAY['create_renewal_request']::text[]),
  ('banking_assistance','Corporate Banking Assistance','Explain partner-bank assistance; approval remains at the bank discretion.',
    ARRAY['Help me open a business bank account']::text[],
    ARRAY['create_referral']::text[])
)
INSERT INTO intents(agent_id, catalog_version_id, intent_key, name, description, examples, allowed_actions)
SELECT a.id, v.id, d.intent_key, d.name, d.description, d.examples, d.allowed_actions
FROM agents a JOIN intent_catalog_versions v ON v.agent_id=a.id AND v.revision=1
CROSS JOIN data d
WHERE a.agent_key='ancfz'
ON CONFLICT(agent_id, catalog_version_id, intent_key) DO NOTHING;

WITH req(intent_key, requirement_key, label, value_type, required_for, guidance) AS (
 VALUES
 ('company_formation','business_activity','What will the company do?','text',ARRAY['create_lead','generate_quote']::text[],'Only ask when missing'),
 ('company_formation','shareholder_count','How many shareholders?','number',ARRAY['generate_quote']::text[],'Ask when relevant for packaging'),
 ('company_formation','visa_count','How many visas?','number',ARRAY['generate_quote']::text[],'Do not re-ask if provided'),
 ('company_formation','office_preference','Preferred office type?','choice',ARRAY['generate_quote']::text[],'Shared or private'),
 ('company_formation','customer_email','Email for the enquiry?','email',ARRAY['create_lead']::text[],'Only ask with purpose and authorization'),
 ('visa_services','visa_count','How many visas?','number',ARRAY['create_enquiry']::text[],NULL),
 ('visa_services','customer_email','Email for the enquiry?','email',ARRAY['create_enquiry']::text[],NULL),
 ('license_renewal','existing_license_reference','Existing licence reference?','text',ARRAY['create_renewal_request']::text[],NULL),
 ('banking_assistance','company_status','Is your company incorporated?','choice',ARRAY['create_referral']::text[],NULL)
)
INSERT INTO intent_requirements(agent_id, intent_id, requirement_key, label, value_type, required_for, guidance)
SELECT i.agent_id, i.id, r.requirement_key, r.label, r.value_type, r.required_for, r.guidance
FROM req r
JOIN intents i ON i.intent_key=r.intent_key
JOIN agents a ON a.id=i.agent_id AND a.agent_key='ancfz'
JOIN intent_catalog_versions v ON v.id=i.catalog_version_id AND v.revision=1
ON CONFLICT(agent_id,intent_id,requirement_key) DO NOTHING;

-- Informational service descriptions only. No unverified commercial prices.
WITH offers(offering_key, label, description, intent_key) AS (
 VALUES
 ('company_setup_consultation','Company Setup Consultation','Assess company-formation requirements; pricing is subject to an approved quotation.','company_formation'),
 ('visa_assistance','Visa Assistance','Discuss residency and employment visa service requirements.','visa_services'),
 ('licence_renewal_support','Licence Renewal Support','Discuss renewal requirements and available support.','license_renewal')
)
INSERT INTO offerings(agent_id,catalog_version_id,offering_key,label,description,intent_key)
SELECT a.id,v.id,o.offering_key,o.label,o.description,o.intent_key
FROM agents a JOIN offering_catalog_versions v ON v.agent_id=a.id AND v.revision=1
CROSS JOIN offers o
WHERE a.agent_key='ancfz'
ON CONFLICT(agent_id,catalog_version_id,offering_key) DO NOTHING;

-- Guard against silently switching an existing published Foundry binding.
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM agents a JOIN agent_versions v
  ON v.agent_id=a.id AND v.id=a.active_version_id
  WHERE a.agent_key='ancfz' AND a.status='active'
    AND v.foundry_project_endpoint = current_setting('p3.foundry_endpoint')
    AND v.foundry_agent_name = current_setting('p3.foundry_name')
    AND v.foundry_agent_version = current_setting('p3.foundry_version')
    AND v.published_at IS NOT NULL
 ) THEN
  RAISE EXCEPTION 'Sara configuration differs from the existing pinned active version; publish a new version explicitly';
 END IF;
END
$$;

COMMIT;
