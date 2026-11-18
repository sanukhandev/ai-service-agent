-- One fresh payment attempt only after an independently verified DECLINED order.
-- Retain all historical provider references, consents, OTPs, and attempts.
BEGIN;

ALTER TABLE ticket_payment_attempts
  DROP CONSTRAINT ticket_payment_attempts_agent_id_ticket_id_quotation_id_key;

ALTER TABLE ticket_payment_attempts
  ADD COLUMN retry_of_payment_id uuid,
  ADD CONSTRAINT ticket_payment_attempts_retry_fk
    FOREIGN KEY(agent_id,ticket_id,retry_of_payment_id)
      REFERENCES ticket_payment_attempts(agent_id,ticket_id,id) ON DELETE RESTRICT;

-- All outcomes except authoritative decline stay blocking, including UNKNOWN,
-- refunded, queued and completed orders. This is also a concurrency safeguard.
CREATE UNIQUE INDEX ticket_payment_one_non_declined_per_quote
  ON ticket_payment_attempts(agent_id,ticket_id,quotation_id)
  WHERE state <> 'payment_declined';

CREATE INDEX ticket_payment_retry_chain
  ON ticket_payment_attempts(agent_id,ticket_id,retry_of_payment_id)
  WHERE retry_of_payment_id IS NOT NULL;

COMMIT;
