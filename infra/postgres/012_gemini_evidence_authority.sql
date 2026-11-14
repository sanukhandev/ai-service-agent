-- Fail-closed claim provenance and same-ticket response audit constraints.
BEGIN;
ALTER TABLE ai_conversation_sessions
 ADD CONSTRAINT ai_session_scoped_ticket UNIQUE(agent_id,id,ticket_id);
ALTER TABLE gemini_response_qualifications
 ADD CONSTRAINT gemini_qualifications_session_ticket_fk
 FOREIGN KEY(agent_id,session_id,ticket_id)
 REFERENCES ai_conversation_sessions(agent_id,id,ticket_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION gemini_qualification_message_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM ticket_messages m
   WHERE m.agent_id=NEW.agent_id AND m.ticket_id=NEW.ticket_id
     AND m.id=NEW.customer_message_id AND m.role='customer'
 ) THEN RAISE EXCEPTION 'Qualification must reference an accepted customer message'; END IF;
 IF NEW.assistant_message_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM ticket_messages m
   WHERE m.agent_id=NEW.agent_id AND m.ticket_id=NEW.ticket_id
     AND m.id=NEW.assistant_message_id AND m.role='assistant'
 ) THEN RAISE EXCEPTION 'Qualification assistant message role mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gemini_qualification_message_guard
 BEFORE INSERT ON gemini_response_qualifications
 FOR EACH ROW EXECUTE FUNCTION gemini_qualification_message_guard();

CREATE OR REPLACE FUNCTION gemini_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 v record;
BEGIN
 SELECT q.session_id,q.ticket_id,q.grounding_status,c.supported,
   s.knowledge_version_id,s.intent_catalog_version_id,s.offering_catalog_version_id
 INTO v
 FROM gemini_response_claims c
 JOIN gemini_response_qualifications q ON q.agent_id=c.agent_id AND q.id=c.qualification_id
 JOIN ai_conversation_sessions s ON s.agent_id=q.agent_id AND s.id=q.session_id
 WHERE c.agent_id=NEW.agent_id AND c.id=NEW.claim_id;
 IF NOT FOUND OR v.grounding_status<>'supported' OR NOT v.supported THEN
   RAISE EXCEPTION 'Evidence cannot support a rejected or unauthorized qualification';
 END IF;
 IF NEW.authority='approved_file_search' THEN
   IF NEW.knowledge_version_id IS DISTINCT FROM v.knowledge_version_id OR NOT EXISTS(
     SELECT 1 FROM gemini_knowledge_documents kd
     JOIN gemini_source_revisions r ON r.agent_id=kd.agent_id AND r.id=kd.document_version_id
     JOIN gemini_knowledge_versions k ON k.agent_id=kd.agent_id AND k.id=kd.knowledge_version_id
     WHERE kd.agent_id=NEW.agent_id AND kd.knowledge_version_id=NEW.knowledge_version_id
       AND kd.document_version_id=NEW.document_version_id
       AND kd.provider_document_resource_name=NEW.evidence_reference
       AND kd.index_status='active' AND r.approval_status='approved'
       AND k.state IN ('published','retired')
   ) THEN RAISE EXCEPTION 'Unapproved or unpinned File Search evidence'; END IF;
 ELSIF NEW.authority='approved_catalog' THEN
   IF NOT (
     EXISTS(SELECT 1 FROM intent_catalog_versions x
        WHERE x.agent_id=NEW.agent_id AND x.id=v.intent_catalog_version_id
          AND x.source_authority='approved'
          AND x.status IN ('published','retired')
          AND NEW.evidence_reference='intent/'||x.id::text)
     OR EXISTS(SELECT 1 FROM offering_catalog_versions x
        WHERE x.agent_id=NEW.agent_id AND x.id=v.offering_catalog_version_id
          AND x.source_authority='approved'
          AND x.status IN ('published','retired')
          AND NEW.evidence_reference='offering/'||x.id::text)
   ) THEN RAISE EXCEPTION 'Unapproved or unpinned catalog evidence'; END IF;
 ELSIF NEW.authority='verified_operation' THEN
   IF NOT EXISTS(
     SELECT 1 FROM ticket_operations o WHERE o.agent_id=NEW.agent_id
       AND o.ticket_id=v.ticket_id AND o.id::text=NEW.evidence_reference
       AND o.state='verified_completed' AND nullif(btrim(o.provider_reference),'') IS NOT NULL
   ) THEN RAISE EXCEPTION 'Unverified provider operation cannot be evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- Replaces the implementation in 011 without changing applied migration bytes.
COMMIT;