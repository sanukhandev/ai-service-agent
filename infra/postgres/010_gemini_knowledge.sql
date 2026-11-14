-- Gemini File Search: immutable version bindings and agent-scoped source provenance.
BEGIN;
CREATE TABLE gemini_knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision > 0),
  state text NOT NULL DEFAULT 'draft'
    CHECK(state IN ('draft','indexing','verified','published','retired','revoked')),
  store_resource_name text,
  content_digest_sha256 char(64),
  approval_reference text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,revision),
  UNIQUE(agent_id,id,store_resource_name),
  CONSTRAINT knowledge_published_complete CHECK (
    state <> 'published' OR (
      nullif(btrim(store_resource_name),'') IS NOT NULL
      AND content_digest_sha256 ~ '^[a-f0-9]{64}$'
      AND nullif(btrim(approval_reference),'') IS NOT NULL
      AND published_at IS NOT NULL
    )
  ),
  CONSTRAINT knowledge_hash_format CHECK (
    content_digest_sha256 IS NULL OR content_digest_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT knowledge_resource_format CHECK (
    store_resource_name IS NULL OR store_resource_name ~ '^fileSearchStores/[A-Za-z0-9_-]+$'
  )
);
CREATE UNIQUE INDEX gemini_knowledge_one_published
  ON gemini_knowledge_versions(agent_id) WHERE state='published';
CREATE UNIQUE INDEX gemini_knowledge_provider_resource_unique
  ON gemini_knowledge_versions(store_resource_name) WHERE store_resource_name IS NOT NULL;

CREATE TABLE gemini_source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source_key text NOT NULL,
  title text NOT NULL CHECK(length(btrim(title)) > 0),
  source_locator text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,source_key)
);
CREATE TABLE gemini_source_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
  original_storage_ref text NOT NULL CHECK(length(btrim(original_storage_ref)) > 0),
  normalized_text_ref text NOT NULL CHECK(length(btrim(normalized_text_ref)) > 0),
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK(approval_status IN ('pending','approved','rejected','revoked')),
  approval_reference text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,document_id,id),
  UNIQUE(agent_id,document_id,revision),
  UNIQUE(agent_id,document_id,source_sha256),
  FOREIGN KEY(agent_id,document_id)
    REFERENCES gemini_source_documents(agent_id,id) ON DELETE RESTRICT,
  CONSTRAINT approved_revision_requires_reference CHECK (
    approval_status <> 'approved' OR
    (nullif(btrim(approval_reference),'') IS NOT NULL AND approved_at IS NOT NULL)
  )
);
CREATE TABLE gemini_knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  knowledge_version_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  provider_document_resource_name text,
  index_status text NOT NULL DEFAULT 'pending'
    CHECK(index_status IN ('pending','indexing','active','failed','revoked')),
  indexed_at timestamptz,
  UNIQUE(agent_id,id),
  UNIQUE(agent_id,knowledge_version_id,document_version_id),
  UNIQUE(agent_id,knowledge_version_id,provider_document_resource_name),
  FOREIGN KEY(agent_id,knowledge_version_id)
    REFERENCES gemini_knowledge_versions(agent_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,document_id,document_version_id)
    REFERENCES gemini_source_revisions(agent_id,document_id,id) ON DELETE RESTRICT,
  CONSTRAINT active_index_requires_provider CHECK (
    index_status <> 'active' OR (
      provider_document_resource_name IS NOT NULL AND indexed_at IS NOT NULL
    )
  ),
  CONSTRAINT provider_document_resource_format CHECK (
    provider_document_resource_name IS NULL OR
    provider_document_resource_name ~ '^fileSearchStores/[A-Za-z0-9_-]+/documents/[A-Za-z0-9_-]+$'
  )
);
CREATE INDEX gemini_document_revisions_by_hash
  ON gemini_source_revisions(agent_id,source_sha256);
CREATE INDEX gemini_knowledge_document_versions
  ON gemini_knowledge_documents(agent_id,knowledge_version_id,index_status);
CREATE INDEX gemini_knowledge_documents_by_revision
  ON gemini_knowledge_documents(agent_id,document_version_id);

CREATE OR REPLACE FUNCTION gemini_knowledge_document_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  store_name text;
  store_state text;
  source_state text;
BEGIN
  SELECT store_resource_name,state INTO store_name,store_state
  FROM gemini_knowledge_versions WHERE agent_id=NEW.agent_id
    AND id=NEW.knowledge_version_id FOR UPDATE;
  SELECT approval_status INTO source_state FROM gemini_source_revisions
    WHERE agent_id=NEW.agent_id AND id=NEW.document_version_id;
  IF store_state IN ('published','retired','revoked') AND
    (TG_OP='INSERT' OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
       OR NEW.provider_document_resource_name IS DISTINCT FROM OLD.provider_document_resource_name) THEN
    RAISE EXCEPTION 'Published knowledge document mapping is immutable';
  END IF;
  IF NEW.index_status='active' AND source_state <> 'approved' THEN
    RAISE EXCEPTION 'Only approved source revisions may be active';
  END IF;
  IF NEW.provider_document_resource_name IS NOT NULL AND store_name IS NOT NULL
    AND NEW.provider_document_resource_name NOT LIKE (store_name || '/documents/%') THEN
    RAISE EXCEPTION 'Document resource must belong to its authorized File Search store';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_document_guard BEFORE INSERT OR UPDATE
  ON gemini_knowledge_documents FOR EACH ROW
  EXECUTE FUNCTION gemini_knowledge_document_guard();

CREATE OR REPLACE FUNCTION gemini_knowledge_publication_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.state IN ('published','retired','revoked') THEN
      RAISE EXCEPTION 'Published or revoked knowledge cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' AND NEW.state <> 'draft' THEN
    RAISE EXCEPTION 'Knowledge starts as draft';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state IN ('published','retired','revoked') THEN
      IF NEW.state NOT IN ('retired','revoked') OR
        NEW.store_resource_name IS DISTINCT FROM OLD.store_resource_name OR
        NEW.content_digest_sha256 IS DISTINCT FROM OLD.content_digest_sha256 OR
        NEW.approval_reference IS DISTINCT FROM OLD.approval_reference OR
        NEW.published_at IS DISTINCT FROM OLD.published_at THEN
        RAISE EXCEPTION 'Published knowledge is immutable except retiring or revoking';
      END IF;
    ELSIF NEW.state <> OLD.state AND NOT (
      (OLD.state='draft' AND NEW.state IN ('indexing','revoked')) OR
      (OLD.state='indexing' AND NEW.state IN ('verified','revoked')) OR
      (OLD.state='verified' AND NEW.state IN ('published','revoked'))
    ) THEN
      RAISE EXCEPTION 'Invalid knowledge publication transition';
    END IF;
  END IF;
  IF NEW.state='published' AND OLD.state IS DISTINCT FROM 'published' THEN
    IF NOT EXISTS(
      SELECT 1 FROM gemini_knowledge_documents d
      JOIN gemini_source_revisions r ON r.agent_id=d.agent_id
        AND r.id=d.document_version_id
      WHERE d.agent_id=NEW.agent_id AND d.knowledge_version_id=NEW.id
        AND d.index_status='active' AND r.approval_status='approved'
        AND nullif(btrim(r.approval_reference),'') IS NOT NULL
        AND d.provider_document_resource_name LIKE (NEW.store_resource_name || '/documents/%')
    ) OR EXISTS(
      SELECT 1 FROM gemini_knowledge_documents d
      JOIN gemini_source_revisions r ON r.agent_id=d.agent_id AND r.id=d.document_version_id
      WHERE d.agent_id=NEW.agent_id AND d.knowledge_version_id=NEW.id
        AND (d.index_status<>'active' OR r.approval_status<>'approved')
    ) THEN
      RAISE EXCEPTION 'All knowledge documents must be approved and actively indexed';
    END IF;
    IF NEW.store_resource_name IS NULL OR NEW.content_digest_sha256 IS NULL
      OR nullif(btrim(NEW.approval_reference),'') IS NULL THEN
      RAISE EXCEPTION 'Knowledge approval, digest and exact store are required';
    END IF;
    NEW.published_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_publication_guard BEFORE INSERT OR UPDATE OR DELETE
  ON gemini_knowledge_versions FOR EACH ROW
  EXECUTE FUNCTION gemini_knowledge_publication_guard();

ALTER TABLE agent_versions
  ADD CONSTRAINT agent_version_knowledge_fk
    FOREIGN KEY(agent_id,knowledge_version_id)
    REFERENCES gemini_knowledge_versions(agent_id,id) ON DELETE RESTRICT;
-- The binding is selected by Node, never from model/tool arguments.
CREATE OR REPLACE FUNCTION gemini_version_knowledge_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.provider='gemini' AND NEW.knowledge_version_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM gemini_knowledge_versions k WHERE k.agent_id=NEW.agent_id
   AND k.id=NEW.knowledge_version_id AND k.state='published'
 ) THEN
   RAISE EXCEPTION 'Only published same-agent knowledge may bind to Gemini';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_version_knowledge_guard BEFORE INSERT OR UPDATE
 ON agent_versions FOR EACH ROW EXECUTE FUNCTION gemini_version_knowledge_guard();

DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY[
  'gemini_knowledge_versions','gemini_source_documents',
  'gemini_source_revisions','gemini_knowledge_documents'
 ] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format(
   'CREATE POLICY agent_scope ON %I USING (agent_id=nullif(current_setting(''app.agent_id'',true),'''')::uuid) WITH CHECK(agent_id=nullif(current_setting(''app.agent_id'',true),'''')::uuid)',t
  );
 END LOOP;
END $$;
GRANT SELECT ON gemini_knowledge_versions,gemini_source_documents,
  gemini_source_revisions,gemini_knowledge_documents TO agent_runtime;
COMMIT;