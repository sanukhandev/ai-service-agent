-- P7 knowledge administration metadata. Immutable migrations 001-014 remain intact.
BEGIN;
ALTER TABLE gemini_knowledge_documents
 ADD COLUMN document_status text NOT NULL DEFAULT 'awaiting_approval'
   CHECK(document_status IN ('awaiting_approval','approved','indexing','indexed','verified','published','failed','retired','revoked')),
 ADD COLUMN operation_name text,
 ADD COLUMN source_name text NOT NULL DEFAULT '',
 ADD COLUMN source_mime text NOT NULL DEFAULT 'application/octet-stream',
 ADD COLUMN required boolean NOT NULL DEFAULT true;
CREATE INDEX gemini_knowledge_documents_status
 ON gemini_knowledge_documents(agent_id,knowledge_version_id,document_status);
-- Operator-only mutations: never grant RAG approval/publication rights to the
-- customer-facing agent_runtime role.
COMMIT;
