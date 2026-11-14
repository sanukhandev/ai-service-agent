-- Allow bounded, independent provider-status polling after an order exists.
-- Read-only GET verification; the order-creation POST remains single-shot.
BEGIN;
ALTER TABLE ticket_payment_attempts
  ADD COLUMN verification_attempts smallint NOT NULL DEFAULT 0
    CHECK(verification_attempts BETWEEN 0 AND 60),
  ADD COLUMN next_verification_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX payment_verification_due
  ON ticket_payment_attempts(agent_id,next_verification_at,id)
  WHERE state IN ('checkout_available','order_created_checkout_unavailable','payment_pending');

GRANT UPDATE(verification_attempts,next_verification_at)
  ON ticket_payment_attempts TO agent_runtime;
COMMIT;
