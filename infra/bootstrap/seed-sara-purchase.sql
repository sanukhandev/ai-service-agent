-- New tickets pin revision 2. Existing revision 1 tickets remain pinned
-- and cannot silently acquire new purchase obligations.
-- The two sandbox documents below are PROVISIONAL POC examples, not an
-- authoritative statement of ANCFZ legal/immigration requirements.
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM intent_catalog_versions v
    JOIN agents a ON a.id=v.agent_id AND a.agent_key='ancfz'
    JOIN intents i ON i.agent_id=v.agent_id AND i.catalog_version_id=v.id
      AND i.intent_key='company_formation'
    WHERE v.revision=2 AND NOT 'purchase_quotation'=ANY(i.allowed_actions)
  ) THEN
    RAISE EXCEPTION 'Revision 2 is already in use for a different catalog; do not overwrite';
  END IF;
END $$;

INSERT INTO intent_catalog_versions(agent_id,revision,status)
SELECT id,2,'draft' FROM agents WHERE agent_key='ancfz'
ON CONFLICT(agent_id,revision) DO NOTHING;

INSERT INTO intents(agent_id,catalog_version_id,intent_key,name,description,examples,allowed_actions)
SELECT i.agent_id,dest.id,i.intent_key,i.name,i.description,i.examples,
  CASE WHEN i.intent_key='company_formation'
    THEN array_append(i.allowed_actions,'purchase_quotation')
    ELSE i.allowed_actions END
FROM intents i
JOIN intent_catalog_versions old ON old.agent_id=i.agent_id AND old.id=i.catalog_version_id AND old.revision=1
JOIN intent_catalog_versions dest ON dest.agent_id=old.agent_id AND dest.revision=2
JOIN agents a ON a.id=i.agent_id AND a.agent_key='ancfz'
ON CONFLICT(agent_id,catalog_version_id,intent_key) DO NOTHING;

INSERT INTO intent_requirements(agent_id,intent_id,requirement_key,label,value_type,required_for,guidance)
SELECT r.agent_id,next.id,r.requirement_key,r.label,r.value_type,r.required_for,r.guidance
FROM intent_requirements r
JOIN intents prior ON prior.agent_id=r.agent_id AND prior.id=r.intent_id
JOIN intent_catalog_versions old ON old.agent_id=prior.agent_id AND old.id=prior.catalog_version_id AND old.revision=1
JOIN intent_catalog_versions dest ON dest.agent_id=r.agent_id AND dest.revision=2
JOIN intents next ON next.agent_id=r.agent_id AND next.catalog_version_id=dest.id AND next.intent_key=prior.intent_key
JOIN agents a ON a.id=r.agent_id AND a.agent_key='ancfz'
ON CONFLICT(agent_id,intent_id,requirement_key) DO NOTHING;

INSERT INTO intent_document_requirements(agent_id,intent_id,requirement_key,label,guidance,required,sort_order)
SELECT i.agent_id,i.id,doc.key,doc.label,doc.guidance,true,doc.ord
FROM agents a
JOIN intent_catalog_versions v ON v.agent_id=a.id AND v.revision=2
JOIN intents i ON i.agent_id=a.id AND i.catalog_version_id=v.id AND i.intent_key='company_formation'
CROSS JOIN (VALUES
  ('shareholder_identity_pack','Shareholder identity documents (sandbox checklist)',
   'Upload one PDF containing the synthetic identity pages for the proposed shareholders. Confirm official documents separately before production use.',1),
  ('registration_application','Company formation application (sandbox checklist)',
   'Upload a synthetic application PDF. This POC list is illustrative, not an officially verified regulatory checklist.',2)
) AS doc(key,label,guidance,ord)
WHERE a.agent_key='ancfz'
ON CONFLICT(agent_id,intent_id,requirement_key) DO NOTHING;

UPDATE intent_catalog_versions v SET status='retired'
FROM agents a WHERE v.agent_id=a.id AND a.agent_key='ancfz' AND v.revision=1
  AND v.status='published';
UPDATE intent_catalog_versions v SET status='published',published_at=COALESCE(v.published_at,now())
FROM agents a WHERE v.agent_id=a.id AND a.agent_key='ancfz' AND v.revision=2
  AND v.status='draft';
COMMIT;
