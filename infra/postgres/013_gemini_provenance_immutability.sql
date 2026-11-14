-- Immutable approved source revisions and auditable assistant publication linkage.
BEGIN;
CREATE OR REPLACE FUNCTION gemini_approved_source_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.approval_status IN ('approved','revoked') OR EXISTS (
     SELECT 1 FROM gemini_knowledge_documents d
     WHERE d.agent_id=OLD.agent_id AND d.document_version_id=OLD.id
   ) THEN RAISE EXCEPTION 'Approved, revoked or bound source revisions cannot be deleted'; END IF;
   RETURN OLD;
 END IF;
 IF OLD.approval_status IN ('approved','revoked') OR EXISTS (
     SELECT 1 FROM gemini_knowledge_documents d
     WHERE d.agent_id=OLD.agent_id AND d.document_version_id=OLD.id
   ) THEN
   IF NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
     OR NEW.original_storage_ref IS DISTINCT FROM OLD.original_storage_ref
     OR NEW.normalized_text_ref IS DISTINCT FROM OLD.normalized_text_ref
     OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
   THEN RAISE EXCEPTION 'Approved or indexed source provenance is immutable'; END IF;
 END IF;
 IF OLD.approval_status='revoked' AND NEW.approval_status<>'revoked' THEN
   RAISE EXCEPTION 'Revoked source revision cannot be reapproved';
 END IF;
 IF OLD.approval_status='approved' AND NEW.approval_status NOT IN ('approved','revoked') THEN
   RAISE EXCEPTION 'Approved source can only remain approved or be revoked';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gemini_approved_source_guard
 BEFORE UPDATE OR DELETE ON gemini_source_revisions FOR EACH ROW
 EXECUTE FUNCTION gemini_approved_source_guard();

CREATE UNIQUE INDEX gemini_qualification_assistant_unique
 ON gemini_response_qualifications(agent_id,assistant_message_id)
 WHERE assistant_message_id IS NOT NULL;
CREATE OR REPLACE FUNCTION gemini_qualification_assistant_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.assistant_message_id IS NOT NULL
   AND NEW.assistant_message_id IS DISTINCT FROM OLD.assistant_message_id THEN
   RAISE EXCEPTION 'Recorded assistant response qualification cannot be unlinked';
 END IF;
 IF NEW.assistant_message_id IS NOT NULL AND (
   NEW.grounding_status <> 'supported'
   OR EXISTS (
     SELECT 1 FROM gemini_response_claims c
     WHERE c.agent_id=NEW.agent_id AND c.qualification_id=NEW.id
       AND NOT c.supported
   )
   OR (NEW.category NOT IN ('social','clarification') AND NOT EXISTS (
     SELECT 1 FROM gemini_response_claims c
     WHERE c.agent_id=NEW.agent_id AND c.qualification_id=NEW.id
   ))
 ) THEN
   RAISE EXCEPTION 'Only independently supported response qualifications can attach assistant output';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gemini_qualification_assistant_guard
 BEFORE UPDATE OF assistant_message_id ON gemini_response_qualifications
 FOR EACH ROW EXECUTE FUNCTION gemini_qualification_assistant_guard();

GRANT UPDATE (assistant_message_id)
 ON gemini_response_qualifications TO agent_runtime;
COMMIT;