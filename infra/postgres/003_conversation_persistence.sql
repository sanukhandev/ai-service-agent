-- Forward-only persistence evolution; apply after 001 and 002 as migration owner.
-- Existing ticket messages are given stable ordinals before the NOT NULL constraint.
BEGIN;

ALTER TABLE tickets
  ADD COLUMN intent_catalog_version_id uuid,
  ADD COLUMN offering_catalog_version_id uuid,
  ADD COLUMN last_message_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_message_sequence >= 0),
  ADD CONSTRAINT tickets_pinned_intent_catalog_fk
    FOREIGN KEY (agent_id, intent_catalog_version_id)
    REFERENCES intent_catalog_versions(agent_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT tickets_pinned_offering_catalog_fk
    FOREIGN KEY (agent_id, offering_catalog_version_id)
    REFERENCES offering_catalog_versions(agent_id, id) ON DELETE RESTRICT;

ALTER TABLE ticket_messages ADD COLUMN message_sequence bigint;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY agent_id, ticket_id ORDER BY created_at, id
  ) AS ordinal
  FROM ticket_messages
)
UPDATE ticket_messages m
SET message_sequence = ranked.ordinal
FROM ranked WHERE m.id = ranked.id;

UPDATE tickets t SET last_message_sequence = COALESCE((
  SELECT max(m.message_sequence) FROM ticket_messages m
  WHERE m.agent_id = t.agent_id AND m.ticket_id = t.id
), 0);

ALTER TABLE ticket_messages
  ALTER COLUMN message_sequence SET NOT NULL,
  ADD CONSTRAINT ticket_messages_sequence_positive CHECK (message_sequence > 0),
  ADD CONSTRAINT ticket_messages_refs_array CHECK (jsonb_typeof(source_references) = 'array');

CREATE UNIQUE INDEX ticket_messages_ordered_unique
  ON ticket_messages(agent_id, ticket_id, message_sequence);

CREATE UNIQUE INDEX ticket_messages_assistant_request_unique
  ON ticket_messages(agent_id, ticket_id, request_id)
  WHERE role = 'assistant' AND request_id IS NOT NULL;

CREATE UNIQUE INDEX ticket_intents_one_active_per_ticket
  ON ticket_intents(agent_id, ticket_id) WHERE status = 'active';

ALTER TABLE event_outbox ADD COLUMN idempotency_key text;
ALTER TABLE event_outbox
  ADD CONSTRAINT event_outbox_idempotency_nonblank CHECK (
    idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 200
  );
CREATE UNIQUE INDEX event_outbox_idempotency_unique
  ON event_outbox(agent_id, ticket_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE ticket_fact_events
  ADD COLUMN old_verification_status text
    CHECK (old_verification_status IS NULL OR old_verification_status IN ('customer_stated', 'verified', 'disputed')),
  ADD COLUMN new_verification_status text
    CHECK (new_verification_status IS NULL OR new_verification_status IN ('customer_stated', 'verified', 'disputed'));

-- Composite keys on existing tables already prevent cross-agent references.
-- The primary replay index is the existing ticket_events unique (agent_id,ticket_id,sequence).
CREATE INDEX ticket_intents_current_lookup
  ON ticket_intents(agent_id, ticket_id, selected_at DESC)
  WHERE status = 'active';

COMMIT;
