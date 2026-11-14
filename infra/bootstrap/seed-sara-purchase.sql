-- Publish a fresh immutable purchase/catalog policy after the current catalog.
-- Safe for 4-intent bootstrap and the separately published 21-intent test catalog.
-- No existing ticket gets silently re-pinned, and repeat bootstraps are no-ops.
BEGIN;
DO $seed$
DECLARE
  agent uuid;
  source_catalog uuid;
  source_revision integer;
  destination uuid;
  new_revision integer;
  missing_policy boolean;
BEGIN
  SELECT id INTO agent FROM agents WHERE agent_key='ancfz' AND status='active' FOR UPDATE;
  IF agent IS NULL THEN RAISE EXCEPTION 'Sara/ANCFZ agent missing'; END IF;

  -- Refuse a corrupt publication state rather than picking an arbitrary revision.
  IF (SELECT count(*) FROM intent_catalog_versions
      WHERE agent_id=agent AND status='published') <> 1 THEN
    RAISE EXCEPTION 'Exactly one published ANCFZ intent catalog is required';
  END IF;
  SELECT id,revision INTO source_catalog,source_revision
  FROM intent_catalog_versions
  WHERE agent_id=agent AND status='published' FOR UPDATE;

  -- Documents are universal. Purchase is offered only when a quote can be
  -- requested; a quote also requires a separately consented Salesforce lead.
  SELECT EXISTS (
    SELECT 1 FROM intents i WHERE i.agent_id=agent
      AND i.catalog_version_id=source_catalog
      AND (
        (('generate_quote'=ANY(i.allowed_actions)) AND
         (NOT 'create_lead'=ANY(i.allowed_actions) OR
          NOT 'purchase_quotation'=ANY(i.allowed_actions)))
        OR (SELECT count(*) FROM intent_document_requirements d
            WHERE d.agent_id=i.agent_id AND d.intent_id=i.id
              AND d.required AND d.requirement_key IN ('passport','emirates_id')) <> 2
        OR (SELECT count(*) FROM intent_document_requirements d
            WHERE d.agent_id=i.agent_id AND d.intent_id=i.id) <> 2
      )
  ) INTO missing_policy;
  IF NOT missing_policy THEN
    RAISE NOTICE 'Current published ANCFZ catalog already has complete purchase-document policy; unchanged';
    RETURN;
  END IF;

  SELECT coalesce(max(revision),0)+1 INTO new_revision
  FROM intent_catalog_versions WHERE agent_id=agent;
  INSERT INTO intent_catalog_versions(agent_id,revision,status)
  VALUES(agent,new_revision,'draft') RETURNING id INTO destination;

  INSERT INTO intents(
    agent_id,catalog_version_id,intent_key,name,description,examples,allowed_actions
  )
  SELECT i.agent_id,destination,i.intent_key,i.name,i.description,i.examples,
    CASE WHEN 'generate_quote'=ANY(i.allowed_actions)
      THEN (
        SELECT array_agg(DISTINCT a)
        FROM unnest(i.allowed_actions||ARRAY['create_lead','purchase_quotation']::text[]) AS a
      )
      ELSE i.allowed_actions END
  FROM intents i WHERE i.agent_id=agent AND i.catalog_version_id=source_catalog;

  INSERT INTO intent_requirements(
    agent_id,intent_id,requirement_key,label,value_type,required_for,guidance
  )
  SELECT r.agent_id,dest.id,r.requirement_key,r.label,r.value_type,
    r.required_for,r.guidance
  FROM intent_requirements r
  JOIN intents src ON src.agent_id=r.agent_id AND src.id=r.intent_id
    AND src.catalog_version_id=source_catalog
  JOIN intents dest ON dest.agent_id=src.agent_id
    AND dest.catalog_version_id=destination AND dest.intent_key=src.intent_key;

  INSERT INTO intent_document_requirements(
    agent_id,intent_id,requirement_key,label,guidance,required,sort_order
  )
  SELECT i.agent_id,i.id,d.key,d.label,d.guidance,true,d.ord
  FROM intents i CROSS JOIN (VALUES
    ('passport','Passport','POC: synthetic passport bio page. OCR extracts the invoice billing name.',1),
    ('emirates_id','Emirates ID','POC: synthetic Emirates ID. OCR extracts holder name for cross-checking.',2)
  ) AS d(key,label,guidance,ord)
  WHERE i.agent_id=agent AND i.catalog_version_id=destination;

  -- Existing sessions keep the old version; new tickets pin the newly
  -- published copy. No mutation of old intent IDs, facts or requirements.
  UPDATE intent_catalog_versions SET status='retired'
  WHERE agent_id=agent AND id=source_catalog AND status='published';
  UPDATE intent_catalog_versions
  SET status='published',published_at=now()
  WHERE agent_id=agent AND id=destination AND status='draft';

  RAISE NOTICE 'Published ANCFZ intent policy revision % from revision % with % intents',
    new_revision,source_revision,
    (SELECT count(*) FROM intents WHERE agent_id=agent AND catalog_version_id=destination);
END $seed$;
COMMIT;
