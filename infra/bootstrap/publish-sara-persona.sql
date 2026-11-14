-- Explicit operator-controlled, atomic Sara persona publication.
-- Copies published bindings/catalogs/permissions and updates only NEW tickets.
-- Never edits a published version, session, customer message or knowledge record.
-- Use via GEMINI_SARA_PUBLISH_PERSONA=YES on isolated Compose migrate.
\set ON_ERROR_STOP on
BEGIN;
\ir sara-persona.sql
DO $publish$
DECLARE
  owner_id uuid;
  previous agent_versions%ROWTYPE;
  next_id uuid;
  next_number integer;
  desired_version text := current_setting('gemini_seed.sara_persona_version');
  desired_instructions text := current_setting('gemini_seed.sara_system_instructions');
  desired_config jsonb := current_setting('gemini_seed.sara_persona_config')::jsonb;
BEGIN
  SELECT a.id INTO owner_id
  FROM agents a WHERE a.agent_key='ancfz' AND a.status='active'
  FOR UPDATE;
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Sara agent missing or inactive: refusing publication';
  END IF;
  SELECT v.* INTO previous FROM agents a
    JOIN agent_versions v ON v.agent_id=a.id AND v.id=a.active_version_id
    WHERE a.id=owner_id AND v.provider='gemini'
      AND v.publication_state='published' AND v.published_at IS NOT NULL;
  IF previous.id IS NULL THEN
    RAISE EXCEPTION 'Sara active version is not published Gemini';
  END IF;
  IF previous.persona_version=desired_version THEN
    IF previous.system_instructions IS DISTINCT FROM desired_instructions
       OR previous.persona_config IS DISTINCT FROM desired_config THEN
      RAISE EXCEPTION 'Persona version label was reused with changed content; choose a new revision';
    END IF;
    RAISE NOTICE 'Sara persona % already published; no changes', desired_version;
    RETURN;
  END IF;
  IF previous.persona_version NOT IN ('sara-gemini-persona-v1') THEN
    RAISE EXCEPTION 'Unexpected Sara persona %, refusing to overwrite a custom or newer revision',
      previous.persona_version;
  END IF;
  IF previous.knowledge_version_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM gemini_knowledge_versions k
    WHERE k.agent_id=owner_id AND k.id=previous.knowledge_version_id
      AND k.state='published'
  ) THEN
    RAISE EXCEPTION 'Active knowledge version is not currently published';
  END IF;
  SELECT coalesce(max(version_number),0)+1 INTO next_number
    FROM agent_versions WHERE agent_id=owner_id;
  INSERT INTO agent_versions(
    agent_id,version_number,provider,model_id,persona_version,
    system_instructions,allowed_node_tools,
    knowledge_status,knowledge_version_id,
    intent_catalog_version_id,offering_catalog_version_id,persona_config
  ) VALUES(
    owner_id,next_number,'gemini',previous.model_id,desired_version,
    desired_instructions,previous.allowed_node_tools,
    previous.knowledge_status,previous.knowledge_version_id,
    previous.intent_catalog_version_id,previous.offering_catalog_version_id,
    desired_config
  ) RETURNING id INTO next_id;
  UPDATE agent_versions SET publication_state='ready'
    WHERE id=next_id AND agent_id=owner_id;
  UPDATE agent_versions SET publication_state='published'
    WHERE id=next_id AND agent_id=owner_id;
  UPDATE agents SET active_version_id=next_id,updated_at=now()
    WHERE id=owner_id AND active_version_id=previous.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sara active-version compare-and-swap failed'; END IF;
  RAISE NOTICE 'Published Sara persona % as agent version % (old tickets still pinned)',
    desired_version,next_number;
END $publish$;
COMMIT;
