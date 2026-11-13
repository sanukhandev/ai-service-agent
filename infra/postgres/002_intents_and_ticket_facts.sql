-- POC Agent-scoped published intent catalog, offerings and durable customer facts.
-- 001_core.sql MUST be applied first. Fresh forward-only migration.
BEGIN;

CREATE TABLE intent_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, revision)
);

CREATE UNIQUE INDEX only_one_published_intent_catalog_per_agent
  ON intent_catalog_versions(agent_id) WHERE status = 'published';

CREATE TABLE intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  intent_key varchar(128) NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  examples text[] NOT NULL DEFAULT ARRAY[]::text[],
  allowed_actions text[] NOT NULL DEFAULT ARRAY[]::text[],
  FOREIGN KEY (agent_id, catalog_version_id)
    REFERENCES intent_catalog_versions(agent_id, id) ON DELETE RESTRICT,
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, catalog_version_id, intent_key),
  CHECK (intent_key ~ '^[a-z][a-z0-9_]{0,127}$')
);

CREATE TABLE intent_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  requirement_key varchar(128) NOT NULL,
  label text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('text', 'number', 'email', 'choice')),
  required_for text[] NOT NULL DEFAULT ARRAY[]::text[],
  guidance text,
  FOREIGN KEY (agent_id, intent_id)
    REFERENCES intents(agent_id, id) ON DELETE RESTRICT,
  UNIQUE (agent_id, intent_id, requirement_key),
  CHECK (requirement_key ~ '^[a-z][a-z0-9_]{0,127}$')
);

CREATE TABLE offering_catalog_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, revision)
);

CREATE UNIQUE INDEX only_one_published_offering_catalog_per_agent
  ON offering_catalog_versions(agent_id) WHERE status = 'published';

CREATE TABLE offerings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  catalog_version_id uuid NOT NULL,
  offering_key varchar(128) NOT NULL,
  label text NOT NULL,
  description text NOT NULL,
  intent_key varchar(128),
  FOREIGN KEY (agent_id, catalog_version_id)
    REFERENCES offering_catalog_versions(agent_id, id) ON DELETE RESTRICT,
  UNIQUE (agent_id, id),
  UNIQUE (agent_id, catalog_version_id, offering_key),
  CHECK (offering_key ~ '^[a-z][a-z0-9_]{0,127}$')
);

CREATE TABLE offering_price_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  currency char(3) NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  conditions text,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  FOREIGN KEY (agent_id, offering_id)
    REFERENCES offerings(agent_id, id) ON DELETE RESTRICT,
  UNIQUE (agent_id, offering_id, revision),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE ticket_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'superseded')),
  selected_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, ticket_id) REFERENCES tickets(agent_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, intent_id) REFERENCES intents(agent_id, id) ON DELETE RESTRICT,
  UNIQUE (agent_id, ticket_id, intent_id)
);

-- Require provenance linked to the SAME ticket, not merely the same agent.
ALTER TABLE ticket_messages
  ADD CONSTRAINT ticket_messages_source_fk_target
  UNIQUE (agent_id, ticket_id, id);

CREATE TABLE ticket_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  fact_key varchar(128) NOT NULL,
  value jsonb NOT NULL,
  verification_status text NOT NULL
    CHECK (verification_status IN ('customer_stated', 'verified', 'disputed')),
  source_message_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, ticket_id)
    REFERENCES tickets(agent_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, ticket_id, source_message_id)
    REFERENCES ticket_messages(agent_id, ticket_id, id) ON DELETE RESTRICT,
  UNIQUE (agent_id, ticket_id, fact_key),
  UNIQUE (agent_id, ticket_id, id),
  UNIQUE (agent_id, id),
  CHECK (jsonb_typeof(value) IN ('string', 'number', 'boolean'))
);

CREATE TABLE ticket_fact_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  source_message_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (agent_id, ticket_id, fact_id)
    REFERENCES ticket_facts(agent_id, ticket_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, ticket_id, source_message_id)
    REFERENCES ticket_messages(agent_id, ticket_id, id) ON DELETE RESTRICT
);

CREATE INDEX intent_catalog_agent_published
  ON intent_catalog_versions(agent_id, status, revision DESC);
CREATE INDEX intent_requirements_for_intent
  ON intent_requirements(agent_id, intent_id, requirement_key);
CREATE INDEX ticket_facts_for_ticket
  ON ticket_facts(agent_id, ticket_id, fact_key);
CREATE INDEX fact_event_history
  ON ticket_fact_events(agent_id, ticket_id, changed_at DESC);
CREATE INDEX offering_prices_current
  ON offering_price_revisions(agent_id, offering_id, effective_from DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'intent_catalog_versions', 'intents', 'intent_requirements',
    'offering_catalog_versions', 'offerings', 'offering_price_revisions',
    'ticket_intents', 'ticket_facts', 'ticket_fact_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY agent_scope ON %I USING (agent_id = nullif(current_setting(''app.agent_id'', true), '''')::uuid) WITH CHECK (agent_id = nullif(current_setting(''app.agent_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
