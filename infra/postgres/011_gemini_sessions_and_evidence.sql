-- Durable Gemini session boundary; independent of guest auth and ticket lifecycle.
BEGIN;
ALTER TABLE tickets ADD CONSTRAINT tickets_session_version_key
  UNIQUE(agent_id,id,agent_version_id);

CREATE TABLE ai_conversation_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 agent_version_id uuid NOT NULL,
 knowledge_version_id uuid,
 intent_catalog_version_id uuid,
 offering_catalog_version_id uuid,
 provider text NOT NULL DEFAULT 'gemini' CHECK(provider='gemini'),
 model_id text NOT NULL CHECK(length(btrim(model_id))>0),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_accepted_customer_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '60 minutes'),
 continuation_opaque_ref text,
 pending_tool_state_ref text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(agent_id,id),
 UNIQUE(agent_id,ticket_id),
 FOREIGN KEY(agent_id,ticket_id,agent_version_id)
   REFERENCES tickets(agent_id,id,agent_version_id) ON DELETE RESTRICT,
 FOREIGN KEY(agent_id,knowledge_version_id)
   REFERENCES gemini_knowledge_versions(agent_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(agent_id,intent_catalog_version_id)
   REFERENCES intent_catalog_versions(agent_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(agent_id,offering_catalog_version_id)
   REFERENCES offering_catalog_versions(agent_id,id) ON DELETE RESTRICT,
 CHECK (expires_at=last_accepted_customer_message_at + interval '60 minutes'),
 CHECK (continuation_opaque_ref IS NULL OR length(continuation_opaque_ref)<=2048),
 CHECK (pending_tool_state_ref IS NULL OR length(pending_tool_state_ref)<=2048),
 CHECK (status='active' OR (continuation_opaque_ref IS NULL AND pending_tool_state_ref IS NULL))
);
CREATE INDEX ai_sessions_expiry ON ai_conversation_sessions(expires_at,id)
 WHERE status='active';
CREATE INDEX ai_sessions_active_agent ON ai_conversation_sessions(agent_id,expires_at)
 WHERE status='active';
-- (agent_id,ticket_id) already indexed by its unique constraint.

CREATE OR REPLACE FUNCTION gemini_session_version_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 v record;
 t record;
BEGIN
 SELECT provider,model_id,publication_state,published_at,
    knowledge_version_id,intent_catalog_version_id,offering_catalog_version_id
 INTO v FROM agent_versions WHERE agent_id=NEW.agent_id AND id=NEW.agent_version_id;
 SELECT intent_catalog_version_id,offering_catalog_version_id INTO t
 FROM tickets WHERE agent_id=NEW.agent_id AND id=NEW.ticket_id;
 IF v.provider IS DISTINCT FROM 'gemini' OR v.published_at IS NULL
 OR v.publication_state <> 'published' OR NEW.model_id<>v.model_id
 OR NEW.knowledge_version_id IS DISTINCT FROM v.knowledge_version_id
 OR NEW.intent_catalog_version_id IS DISTINCT FROM t.intent_catalog_version_id
 OR NEW.offering_catalog_version_id IS DISTINCT FROM t.offering_catalog_version_id
 THEN RAISE EXCEPTION 'AI session pinned configuration does not match authoritative ticket/version'; END IF;
 IF NEW.knowledge_version_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM gemini_knowledge_versions WHERE agent_id=NEW.agent_id
 AND id=NEW.knowledge_version_id AND state IN ('published','retired')
 ) THEN RAISE EXCEPTION 'AI session knowledge is not authorized'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_session_pin_guard BEFORE INSERT ON ai_conversation_sessions
 FOR EACH ROW EXECUTE FUNCTION gemini_session_version_guard();

-- Every evidence row is tied to a verifier decision, not a model citation alone.
CREATE TABLE gemini_response_qualifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id uuid NOT NULL,
 session_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 customer_message_id uuid NOT NULL,
 assistant_message_id uuid,
 category text NOT NULL CHECK(category IN ('social','clarification',
   'business_factual','catalog_factual','operation_status')),
 grounding_status text NOT NULL CHECK(grounding_status IN ('supported','unsupported',
  'insufficient_evidence','unauthorized_source','verifier_unavailable')),
 verifier_version text NOT NULL CHECK(length(btrim(verifier_version))>0),
 reason_code text,
 assessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(agent_id,id),
 UNIQUE(agent_id,session_id,id),
 FOREIGN KEY(agent_id,session_id)
  REFERENCES ai_conversation_sessions(agent_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(agent_id,ticket_id,customer_message_id)
  REFERENCES ticket_messages(agent_id,ticket_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(agent_id,ticket_id,assistant_message_id)
  REFERENCES ticket_messages(agent_id,ticket_id,id) ON DELETE RESTRICT
);
CREATE TABLE gemini_response_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id uuid NOT NULL,
 qualification_id uuid NOT NULL,
 claim_key text NOT NULL,
 claim_text text NOT NULL,
 supported boolean NOT NULL,
 reason text,
 UNIQUE(agent_id,id),
 UNIQUE(agent_id,qualification_id,claim_key),
 FOREIGN KEY(agent_id,qualification_id)
   REFERENCES gemini_response_qualifications(agent_id,id) ON DELETE RESTRICT
);
CREATE TABLE gemini_response_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 agent_id uuid NOT NULL,
 claim_id uuid NOT NULL,
 authority text NOT NULL CHECK(authority IN ('approved_file_search',
   'approved_catalog','verified_operation')),
 knowledge_version_id uuid,
 document_version_id uuid,
 evidence_reference text NOT NULL,
 excerpt text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(agent_id,claim_id)
   REFERENCES gemini_response_claims(agent_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(agent_id,knowledge_version_id,document_version_id)
   REFERENCES gemini_knowledge_documents(agent_id,knowledge_version_id,document_version_id)
   ON DELETE RESTRICT,
 CHECK ((authority='approved_file_search' AND knowledge_version_id IS NOT NULL
   AND document_version_id IS NOT NULL) OR
   (authority<>'approved_file_search' AND knowledge_version_id IS NULL
     AND document_version_id IS NULL))
);
CREATE INDEX gemini_qualifications_by_session
 ON gemini_response_qualifications(agent_id,session_id,assessed_at DESC);
CREATE INDEX gemini_response_evidence_by_claim
 ON gemini_response_evidence(agent_id,claim_id);

CREATE OR REPLACE FUNCTION gemini_evidence_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.authority='approved_file_search' AND NOT EXISTS (
 SELECT 1 FROM gemini_response_claims c
 JOIN gemini_response_qualifications q ON q.id=c.qualification_id AND q.agent_id=c.agent_id
 JOIN ai_conversation_sessions s ON s.id=q.session_id AND s.agent_id=q.agent_id
 JOIN gemini_knowledge_documents kd ON kd.agent_id=NEW.agent_id
   AND kd.knowledge_version_id=NEW.knowledge_version_id
   AND kd.document_version_id=NEW.document_version_id
 JOIN gemini_source_revisions r ON r.agent_id=kd.agent_id
   AND r.id=kd.document_version_id
 JOIN gemini_knowledge_versions k ON k.agent_id=kd.agent_id
   AND k.id=kd.knowledge_version_id
 WHERE c.agent_id=NEW.agent_id AND c.id=NEW.claim_id
   AND s.knowledge_version_id=NEW.knowledge_version_id
   AND kd.index_status='active' AND r.approval_status='approved'
   AND k.state IN ('published','retired')
   AND kd.provider_document_resource_name=NEW.evidence_reference
 ) THEN RAISE EXCEPTION 'Evidence must reference authorized pinned approved active File Search source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gemini_evidence_guard BEFORE INSERT ON gemini_response_evidence
 FOR EACH ROW EXECUTE FUNCTION gemini_evidence_guard();

DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'ai_conversation_sessions','gemini_response_qualifications',
  'gemini_response_claims','gemini_response_evidence'
 ] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format(
   'CREATE POLICY agent_scope ON %I USING (agent_id=nullif(current_setting(''app.agent_id'',true),'''')::uuid) WITH CHECK(agent_id=nullif(current_setting(''app.agent_id'',true),'''')::uuid)',t
  );
 END LOOP;
END $$;
GRANT SELECT,INSERT ON ai_conversation_sessions TO agent_runtime;
GRANT UPDATE(status,last_accepted_customer_message_at,expires_at,
  continuation_opaque_ref,pending_tool_state_ref,updated_at)
  ON ai_conversation_sessions TO agent_runtime;
GRANT SELECT,INSERT ON gemini_response_qualifications,gemini_response_claims,
  gemini_response_evidence TO agent_runtime;
COMMIT;