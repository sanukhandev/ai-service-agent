-- Explicit owner-only activation of inert Gemini action tools on an existing Sara
-- deployment. Do NOT mutate immutable published agent versions or live tickets.
-- Run only on the isolated experiment Postgres, after migration 021/022.
BEGIN;
DO $publish$
DECLARE
  owner_id uuid;
  prior agent_versions%ROWTYPE;
  new_id uuid;
  new_number integer;
  desired text[]:=ARRAY['preflight_operation','propose_operation']::text[];
BEGIN
  SELECT a.id INTO owner_id FROM agents a
    WHERE a.agent_key='ancfz' AND a.status='active'
    FOR UPDATE;
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Sara/ANCFZ agent not active; refusing publication';
  END IF;
  SELECT v.* INTO prior FROM agent_versions v
    JOIN agents a ON a.active_version_id=v.id AND a.id=v.agent_id
    WHERE a.id=owner_id AND v.provider='gemini' AND v.publication_state='published';
  IF prior.id IS NULL THEN
    RAISE EXCEPTION 'Active Sara version is not a published Gemini version';
  END IF;
  IF prior.allowed_node_tools @> desired THEN
    RAISE NOTICE 'Sara already allows preflight/propose; no new version created';
    RETURN;
  END IF;
  SELECT coalesce(max(version_number),0)+1 INTO new_number
    FROM agent_versions WHERE agent_id=owner_id;
  INSERT INTO agent_versions(
    agent_id,version_number,provider,model_id,persona_version,system_instructions,
    allowed_node_tools,knowledge_status,knowledge_version_id,
    intent_catalog_version_id,offering_catalog_version_id,persona_config
  ) VALUES(
    owner_id,new_number,'gemini',prior.model_id,prior.persona_version,
    prior.system_instructions,
    prior.allowed_node_tools ||
      ARRAY(SELECT name FROM unnest(desired) name
        WHERE NOT name=ANY(prior.allowed_node_tools)),
    prior.knowledge_status,prior.knowledge_version_id,
    prior.intent_catalog_version_id,prior.offering_catalog_version_id,
    prior.persona_config
  ) RETURNING id INTO new_id;
  UPDATE agent_versions SET publication_state='ready'
    WHERE agent_id=owner_id AND id=new_id;
  UPDATE agent_versions SET publication_state='published'
    WHERE agent_id=owner_id AND id=new_id;
  UPDATE agents SET active_version_id=new_id,updated_at=now() WHERE id=owner_id;
  RAISE NOTICE 'Published Sara version % with inert operation proposal tools',new_number;
END $publish$;
COMMIT;
