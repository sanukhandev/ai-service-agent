-- Minimum ID-derived fields needed for a TEST invoice.
-- Do not persist raw OCR output or full passport/Emirates ID numbers.
BEGIN;
ALTER TABLE ticket_purchase_documents
  ADD COLUMN extracted_full_name varchar(200),
  ADD COLUMN document_number_last4 char(4),
  ADD COLUMN extraction_model text,
  ADD COLUMN extraction_status text NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending','extracted')),
  ADD CONSTRAINT purchase_extracted_name CHECK (
    extracted_full_name IS NULL OR
    char_length(btrim(extracted_full_name)) BETWEEN 2 AND 200
  ),
  ADD CONSTRAINT purchase_last4 CHECK (
    document_number_last4 IS NULL OR document_number_last4 ~ '^[A-Za-z0-9]{4}$'
  );
CREATE INDEX ticket_purchase_extracted_identity
  ON ticket_purchase_documents(agent_id,ticket_id,intent_id,requirement_id)
  WHERE state='received' AND extraction_status='extracted';
COMMIT;
