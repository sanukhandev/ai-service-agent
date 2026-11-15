-- Permit one reviewed pending -> approved source transition after intake has
-- created the knowledge-document link, without reopening immutable provenance.
-- Supersedes the trigger function from migration 013; never edit applied DDL.
BEGIN;
CREATE OR REPLACE FUNCTION gemini_approved_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  linked boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM gemini_knowledge_documents d
    WHERE d.agent_id=OLD.agent_id AND d.document_version_id=OLD.id
  ) INTO linked;

  IF TG_OP='DELETE' THEN
    IF OLD.approval_status IN ('approved','revoked') OR linked THEN
      RAISE EXCEPTION 'Approved, revoked or bound source revisions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  -- Once inserted, the source identity, hashes and retained evidence references
  -- must not change, regardless of the approval state.
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
    OR NEW.original_storage_ref IS DISTINCT FROM OLD.original_storage_ref
    OR NEW.normalized_text_ref IS DISTINCT FROM OLD.normalized_text_ref
    OR NEW.normalized_text_sha256 IS DISTINCT FROM OLD.normalized_text_sha256
  THEN RAISE EXCEPTION 'Source provenance is immutable'; END IF;

  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status AND NOT (
    (OLD.approval_status='pending' AND NEW.approval_status IN ('approved','rejected'))
    OR (OLD.approval_status='approved' AND NEW.approval_status='revoked')
  ) THEN
    RAISE EXCEPTION 'Invalid source approval transition';
  END IF;

  IF OLD.approval_status='pending' AND NEW.approval_status='approved' THEN
    -- Approval must be the first and only write of its reference and timestamp.
    -- Source may be linked but must still be awaiting the operator decision.
    IF OLD.approval_reference IS NOT NULL OR OLD.approved_at IS NOT NULL
      OR nullif(btrim(NEW.approval_reference),'') IS NULL
      OR NEW.approved_at IS NULL
      OR EXISTS (
        SELECT 1 FROM gemini_knowledge_documents d
        WHERE d.agent_id=OLD.agent_id AND d.document_version_id=OLD.id
          AND (d.document_status<>'awaiting_approval' OR d.index_status<>'pending')
      )
    THEN RAISE EXCEPTION 'Source approval must be reviewed before indexing'; END IF;
  ELSIF NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'Approved source reference and timestamp are immutable';
  END IF;

  RETURN NEW;
END $$;
COMMIT;
