-- The MockGateway GET route is keyed by provider payment_id, which is not
-- the display order RefNo. Keep both; never treat a browser redirect as proof
-- of payment or replay a POST to recover a missing ID.
BEGIN;
ALTER TABLE ticket_payment_attempts
  ADD COLUMN provider_payment_id text
    CHECK(provider_payment_id IS NULL OR
          provider_payment_id ~ '^[A-Za-z0-9_-]{1,120}$');
CREATE UNIQUE INDEX payment_provider_id_unique
  ON ticket_payment_attempts(agent_id,provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
GRANT UPDATE(provider_payment_id) ON ticket_payment_attempts TO agent_runtime;
COMMIT;
