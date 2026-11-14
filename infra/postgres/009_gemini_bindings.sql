-- Gemini experiment only: additive agent/provider binding and catalog authority.
-- Preserve checksums of 001-008. The original Foundry rows remain valid.
BEGIN;
ALTER TABLE agent_versions
  ALTER COLUMN foundry_project_endpoint DROP NOT NULL,
  ALTER COLUMN foundry_agent_name DROP NOT NULL,
  ALTER COLUMN foundry_agent_version DROP NOT NULL,
  ADD COLUMN provider text NOT NULL DEFAULT 'foundry'
    CHECK (provider IN ('foundry','gemini')),
  ADD COLUMN model_id text,
  ADD COLUMN persona_version text,
  ADD COLUMN system_instructions text,
  ADD COLUMN allowed_node_tools text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN publication_state text NOT NULL DEFAULT 'draft'
    CHECK (publication_state IN ('draft','ready','published')),
  ADD COLUMN knowledge_version_id uuid,
  ADD COLUMN knowledge_status text NOT NULL DEFAULT 'awaiting_publication'
    CHECK (knowledge_status IN ('awaiting_publication','bound')),
  ADD COLUMN intent_catalog_version_id uuid,
  ADD COLUMN offering_catalog_version_id uuid,
  ADD CONSTRAINT agent_version_provider_configuration CHECK (
    (provider = 'foundry' AND foundry_project_endpoint IS NOT NULL
      AND foundry_agent_name IS NOT NULL AND foundry_agent_version IS NOT NULL)
    OR
    (provider = 'gemini'
      AND foundry_project_endpoint IS NULL AND foundry_agent_name IS NULL
      AND foundry_agent_version IS NULL
      AND nullif(btrim(model_id),'') IS NOT NULL
      AND nullif(btrim(persona_version),'') IS NOT NULL
      AND nullif(btrim(system_instructions),'') IS NOT NULL
      AND cardinality(allowed_node_tools) > 0
      AND allowed_node_tools <@ ARRAY[
        'find_intents','select_ticket_intent','get_intent_requirements',
        'record_ticket_facts','get_offerings','get_ticket_context',
        'get_document_data','get_operation_status',
        'preflight_operation','propose_operation'
      ]::text[]
      AND ((knowledge_version_id IS NULL AND knowledge_status = 'awaiting_publication')
        OR (knowledge_version_id IS NOT NULL AND knowledge_status = 'bound')))
  ),
  ADD CONSTRAINT agent_versions_intent_catalog_fk FOREIGN KEY (agent_id,intent_catalog_version_id)
    REFERENCES intent_catalog_versions(agent_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT agent_versions_offering_catalog_fk FOREIGN KEY (agent_id,offering_catalog_version_id)
    REFERENCES offering_catalog_versions(agent_id,id) ON DELETE RESTRICT;

UPDATE agent_versions SET publication_state = CASE WHEN published_at IS NULL
  THEN 'draft' ELSE 'published' END;

CREATE OR REPLACE FUNCTION gemini_agent_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'Published agent versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'Published agent versions are immutable; create a new version';
    END IF;
    IF NEW.publication_state <> OLD.publication_state
      AND NOT (
        (OLD.publication_state = 'draft' AND NEW.publication_state = 'ready')
        OR (OLD.publication_state = 'ready' AND NEW.publication_state = 'published')
      ) THEN
      RAISE EXCEPTION 'Invalid agent version publication transition';
    END IF;
  ELSIF NEW.publication_state <> 'draft' OR NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Insert agent version as draft before publication';
  END IF;
  IF NEW.publication_state = 'published' AND NEW.published_at IS NULL THEN
    NEW.published_at := clock_timestamp();
  END IF;
  IF NEW.publication_state <> 'published' AND NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'Unpublished version cannot have published_at';
  END IF;
  IF NEW.provider = 'gemini' AND
    (SELECT count(DISTINCT t) FROM unnest(NEW.allowed_node_tools) t)
       <> cardinality(NEW.allowed_node_tools) THEN
    RAISE EXCEPTION 'Duplicate Gemini tool names';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_version_publication_guard
  BEFORE INSERT OR UPDATE OR DELETE ON agent_versions
  FOR EACH ROW EXECUTE FUNCTION gemini_agent_version_guard();

ALTER TABLE intent_catalog_versions
  ADD COLUMN source_authority text NOT NULL DEFAULT 'unapproved'
    CHECK (source_authority IN ('unapproved','approved','revoked')),
  ADD COLUMN approval_reference text,
  ADD COLUMN source_reference text,
  ADD CONSTRAINT intent_catalog_approved_requires_reference
    CHECK (source_authority <> 'approved'
      OR nullif(btrim(approval_reference),'') IS NOT NULL);
ALTER TABLE offering_catalog_versions
  ADD COLUMN source_authority text NOT NULL DEFAULT 'unapproved'
    CHECK (source_authority IN ('unapproved','approved','revoked')),
  ADD COLUMN approval_reference text,
  ADD COLUMN source_reference text,
  ADD CONSTRAINT offering_catalog_approved_requires_reference
    CHECK (source_authority <> 'approved'
      OR nullif(btrim(approval_reference),'') IS NOT NULL);

-- Owner-only catalog approval; runtime has read-only rights.
REVOKE UPDATE ON intent_catalog_versions,offering_catalog_versions FROM agent_runtime;
COMMIT;