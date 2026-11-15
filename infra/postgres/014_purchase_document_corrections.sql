-- Controlled replacement of synthetic identity documents before customer consent.
-- RLS and agent-scoped FK constraints remain in force; replacements are audited
-- through ticket_events (old/new SHA-256, never old private bytes).
BEGIN;
ALTER TABLE ticket_purchase_documents
  ADD COLUMN replaced_at timestamptz;
GRANT UPDATE (
  file_name,content_type,bytes,sha256,extracted_full_name,
  document_number_last4,extraction_model,extraction_status,replaced_at
) ON ticket_purchase_documents TO agent_runtime;
COMMIT;
