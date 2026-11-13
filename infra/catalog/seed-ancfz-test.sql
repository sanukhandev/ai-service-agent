\set ON_ERROR_STOP on

-- Run only with scripts/publish-ancfz-test-catalog.sh --publish-test.
-- This is a controlled, owner-authenticated *test* seed. Customer runtime
-- agent_runtime has no catalog write grants.
BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('ancfz-test-catalog-publication-v1'));

CREATE TEMP TABLE _ancfz_catalog_input (payload jsonb NOT NULL) ON COMMIT DROP;
-- Owner-only test publication reads the short-lived JSON file copied inside Postgres.
-- Never pass the 90 KiB payload through docker.exe arguments on Windows.
INSERT INTO _ancfz_catalog_input(payload) VALUES (pg_read_file(:'seed_file')::jsonb);

-- PSQL variables are SQL-escaped by :'<variable>'; do not interpolate
-- untrusted shell strings into a DO block.
SELECT set_config('ancfz_seed.foundry_endpoint', :'foundry_endpoint', true);
SELECT set_config('ancfz_seed.foundry_name', :'foundry_name', true);
SELECT set_config('ancfz_seed.foundry_version', :'foundry_version', true);

CREATE TABLE IF NOT EXISTS ancfz_test_catalog_seed_receipts (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  seed_key text NOT NULL,
  payload_md5 text NOT NULL,
  intent_catalog_version_id uuid NOT NULL,
  offering_catalog_version_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, seed_key)
);

DO $seed$
DECLARE
  p jsonb;
  a uuid;
  av uuid;
  iv uuid;
  ov uuid;
  ix uuid;
  ox uuid;
  r jsonb;
  x jsonb;
  req jsonb;
  price jsonb;
  checksum text;
  existing_receipt record;
  endpoint text;
  foundry_name text;
  foundry_version text;
  next_version integer;
BEGIN
  SELECT payload INTO STRICT p FROM _ancfz_catalog_input;

  IF p->>'agentKey' <> 'ancfz'
     OR p->>'environment' <> 'test'
     OR p->>'publication' <> 'published'
     OR p->>'schemaVersion' <> 'ancfz-poc-catalog-1'
     OR jsonb_typeof(p->'intents') <> 'array'
     OR jsonb_typeof(p->'offerings') <> 'array'
     OR jsonb_array_length(p->'intents') = 0
     OR jsonb_array_length(p->'offerings') = 0
     OR length(p->>'seedKey') < 5
  THEN
    RAISE EXCEPTION 'Refusing invalid or non-test ANCFZ catalog payload';
  END IF;

  endpoint := nullif(current_setting('ancfz_seed.foundry_endpoint', true), '');
  foundry_name := nullif(current_setting('ancfz_seed.foundry_name', true), '');
  foundry_version := nullif(current_setting('ancfz_seed.foundry_version', true), '');
  IF endpoint IS NULL OR endpoint NOT LIKE 'https://%/api/projects/%'
    OR foundry_name IS NULL OR foundry_version IS NULL THEN
    RAISE EXCEPTION 'Require explicit published Foundry project endpoint/name/version';
  END IF;
  checksum := md5(p::text);

  INSERT INTO agents(agent_key, display_name, status)
  VALUES ('ancfz', p->>'agentDisplayName', 'active')
  ON CONFLICT (agent_key) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        status = 'active',
        updated_at = now();
  SELECT id INTO STRICT a FROM agents WHERE agent_key = 'ancfz' FOR UPDATE;

  SELECT payload_md5, intent_catalog_version_id, offering_catalog_version_id
    INTO existing_receipt
  FROM ancfz_test_catalog_seed_receipts
  WHERE agent_id = a AND seed_key = p->>'seedKey';
  IF FOUND THEN
    IF existing_receipt.payload_md5 <> checksum THEN
      RAISE EXCEPTION 'Seed key % already used for different data. Bump seedKey and revisions.', p->>'seedKey';
    END IF;
    -- Never silently republish an earlier catalog once newer versions exist.
    RAISE NOTICE 'Identical ANCFZ seed already applied. No catalog changes.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM intent_catalog_versions
             WHERE agent_id = a AND revision = (p->>'intentRevision')::integer)
    OR EXISTS (SELECT 1 FROM offering_catalog_versions
             WHERE agent_id = a AND revision = (p->>'offeringRevision')::integer)
  THEN
    RAISE EXCEPTION 'Catalog revision collision. Use fresh, immutable test revisions.';
  END IF;

  SELECT id INTO av
  FROM agent_versions
  WHERE agent_id = a
    AND foundry_project_endpoint = endpoint
    AND foundry_agent_name = foundry_name
    AND foundry_agent_version = foundry_version
    AND published_at IS NOT NULL
  ORDER BY version_number DESC LIMIT 1;

  IF av IS NULL THEN
    SELECT coalesce(max(version_number), 0) + 1 INTO next_version
    FROM agent_versions WHERE agent_id = a;
    INSERT INTO agent_versions (
      agent_id, version_number, foundry_project_endpoint,
      foundry_agent_name, foundry_agent_version, persona_config, published_at
    ) VALUES (
      a, next_version, endpoint, foundry_name, foundry_version,
      jsonb_build_object(
        'catalogEnvironment', 'test',
        'sourceReviewStatus', p->>'reviewStatus',
        'catalogSeedKey', p->>'seedKey'
      ), now()
    ) RETURNING id INTO av;
  END IF;
  UPDATE agents SET active_version_id = av, updated_at = now() WHERE id = a;

  INSERT INTO intent_catalog_versions(agent_id, revision, status)
  VALUES (a, (p->>'intentRevision')::integer, 'draft') RETURNING id INTO iv;
  FOR r IN SELECT value FROM jsonb_array_elements(p->'intents') LOOP
    IF r->>'key' !~ '^[a-z][a-z0-9_]{0,127}$' OR jsonb_typeof(r->'requirements') <> 'array'
      OR jsonb_typeof(r->'examplePhrases') <> 'array' OR jsonb_typeof(r->'allowedActions') <> 'array'
    THEN RAISE EXCEPTION 'Malformed intent entry: %', r->>'key'; END IF;
    INSERT INTO intents(
      agent_id, catalog_version_id, intent_key, name,
      description, examples, allowed_actions
    ) VALUES (
      a, iv, r->>'key', r->>'name', r->>'description',
      ARRAY(SELECT jsonb_array_elements_text(r->'examplePhrases')),
      ARRAY(SELECT jsonb_array_elements_text(r->'allowedActions'))
    ) RETURNING id INTO ix;
    FOR req IN SELECT value FROM jsonb_array_elements(r->'requirements') LOOP
      INSERT INTO intent_requirements(
        agent_id, intent_id, requirement_key, label, value_type,
        required_for, guidance
      ) VALUES (
        a, ix, req->>'key', req->>'label', req->>'type',
        ARRAY(SELECT jsonb_array_elements_text(req->'requiredFor')),
        nullif(req->>'hint', '')
      );
    END LOOP;
  END LOOP;

  INSERT INTO offering_catalog_versions(agent_id, revision, status)
  VALUES (a, (p->>'offeringRevision')::integer, 'draft') RETURNING id INTO ov;
  FOR x IN SELECT value FROM jsonb_array_elements(p->'offerings') LOOP
    IF x->>'key' !~ '^[a-z][a-z0-9_]{0,127}$'
      OR x->>'label' IS NULL OR x->>'description' IS NULL
    THEN RAISE EXCEPTION 'Malformed offering: %', x->>'key'; END IF;
    INSERT INTO offerings(
      agent_id, catalog_version_id, offering_key,
      label, description, intent_key
    ) VALUES (
      a, ov, x->>'key', x->>'label',
      (x->>'description') || ' [Test source: ' || (x->>'sourceDocument') || ']',
      x->>'intentKey'
    ) RETURNING id INTO ox;
    price := x->'price';
    IF price IS NOT NULL AND jsonb_typeof(price) <> 'null' THEN
      INSERT INTO offering_price_revisions (
        agent_id, offering_id, revision, currency,
        amount, conditions, effective_from, effective_to
      ) VALUES (
        a, ox, 1, price->>'currency', (price->>'amount')::numeric,
        price->>'conditions',
        (price->>'effectiveFrom')::timestamptz,
        (price->>'effectiveTo')::timestamptz
      );
    END IF;
  END LOOP;

  -- Enforce exactly one published version while keeping pinned historical
  -- revisions readable for existing conversations.
  UPDATE intent_catalog_versions SET status = 'retired'
    WHERE agent_id = a AND status = 'published';
  UPDATE offering_catalog_versions SET status = 'retired'
    WHERE agent_id = a AND status = 'published';
  UPDATE intent_catalog_versions SET status = 'published', published_at = now()
    WHERE id = iv;
  UPDATE offering_catalog_versions SET status = 'published', published_at = now()
    WHERE id = ov;

  INSERT INTO ancfz_test_catalog_seed_receipts(
    agent_id, seed_key, payload_md5,
    intent_catalog_version_id, offering_catalog_version_id
  ) VALUES (a, p->>'seedKey', checksum, iv, ov);

  RAISE NOTICE 'ANCFZ test published: % intents, % offerings, % price variants.',
    (SELECT count(*) FROM intents WHERE catalog_version_id = iv),
    (SELECT count(*) FROM offerings WHERE catalog_version_id = ov),
    (SELECT count(*) FROM offering_price_revisions WHERE offering_id IN
      (SELECT id FROM offerings WHERE catalog_version_id = ov));
END;
$seed$;

COMMIT;

-- Read-only verification for operator, no fabricated runtime success.
SELECT
  a.agent_key,
  (SELECT revision FROM intent_catalog_versions
    WHERE agent_id = a.id AND status = 'published') AS intent_revision,
  (SELECT count(*) FROM intents i
    JOIN intent_catalog_versions v ON v.id = i.catalog_version_id
    WHERE v.agent_id = a.id AND v.status = 'published') AS published_intents,
  (SELECT revision FROM offering_catalog_versions
    WHERE agent_id = a.id AND status = 'published') AS offering_revision,
  (SELECT count(*) FROM offerings o
    JOIN offering_catalog_versions v ON v.id = o.catalog_version_id
    WHERE v.agent_id = a.id AND v.status = 'published') AS published_offerings,
  (SELECT count(*) FROM offering_price_revisions pr
    JOIN offerings o ON o.id = pr.offering_id
    JOIN offering_catalog_versions v ON v.id = o.catalog_version_id
    WHERE v.agent_id = a.id AND v.status = 'published') AS published_prices
FROM agents a WHERE agent_key = 'ancfz';
