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

-- Store metadata and explicit test provenance only; no model publication.
CREATE TABLE IF NOT EXISTS ancfz_test_catalog_seed_receipts (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  seed_key text NOT NULL,
  payload_md5 text NOT NULL,
  intent_catalog_version_id uuid NOT NULL,
  offering_catalog_version_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, seed_key)
);

ALTER TABLE ancfz_test_catalog_seed_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ancfz_test_catalog_seed_receipts FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
   AND tablename='ancfz_test_catalog_seed_receipts' AND policyname='agent_scope') THEN
  CREATE POLICY agent_scope ON ancfz_test_catalog_seed_receipts
   USING (agent_id=nullif(current_setting('app.agent_id',true),'')::uuid)
   WITH CHECK(agent_id=nullif(current_setting('app.agent_id',true),'')::uuid);
 END IF;
END $policy$;

DO $seed$
DECLARE
  p jsonb;
  a uuid;
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

  checksum := md5(p::text);


  SELECT id INTO STRICT a FROM agents WHERE agent_key='ancfz' AND status='active' FOR UPDATE;
  IF NOT EXISTS(
    SELECT 1 FROM agent_versions v JOIN agents ag ON ag.active_version_id=v.id
     AND ag.id=v.agent_id
    WHERE ag.id=a AND v.provider='gemini' AND v.publication_state='published'
  ) THEN RAISE EXCEPTION 'Publish the Gemini Sara agent before publishing test catalogs'; END IF;


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


  INSERT INTO intent_catalog_versions(agent_id, revision, status,source_authority,source_reference)
  VALUES (a, (p->>'intentRevision')::integer, 'draft','unapproved',p->>'seedKey') RETURNING id INTO iv;
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
      CASE WHEN 'generate_quote' IN (
        SELECT jsonb_array_elements_text(r->'allowedActions')
      ) THEN ARRAY(SELECT DISTINCT action FROM (
        SELECT jsonb_array_elements_text(r->'allowedActions') AS action
        UNION ALL SELECT 'create_lead'
        UNION ALL SELECT 'purchase_quotation'
      ) allowed)
      ELSE array_remove(ARRAY(SELECT jsonb_array_elements_text(r->'allowedActions')),
        'purchase_quotation') END
    ) RETURNING id INTO ix;
    -- Only synthetic identity documents are accepted for this isolated POC.
    -- Document receipt is not independent identity verification.
    INSERT INTO intent_document_requirements(
      agent_id,intent_id,requirement_key,label,guidance,required,sort_order
    ) VALUES
      (a,ix,'passport','Passport',
       'POC: synthetic passport bio page; extract name only after explicit consent',true,1),
      (a,ix,'emirates_id','Emirates ID',
       'POC: synthetic Emirates ID; cross-check name without storing full ID',true,2);
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

  INSERT INTO offering_catalog_versions(agent_id, revision, status,source_authority,source_reference)
  VALUES (a, (p->>'offeringRevision')::integer, 'draft','unapproved',p->>'seedKey') RETURNING id INTO ov;
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
