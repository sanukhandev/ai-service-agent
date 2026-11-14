\set ON_ERROR_STOP on
-- Disposable-DB-only P2 assertions. Everything in this file rolls back.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $preflight$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agent_runtime'
   AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
 THEN RAISE EXCEPTION 'Unsafe or missing runtime role'; END IF;
 IF has_table_privilege('agent_runtime','gemini_knowledge_versions','UPDATE')
 OR has_table_privilege('agent_runtime','agent_versions','INSERT')
 OR has_table_privilege('agent_runtime','offering_catalog_versions','UPDATE')
 THEN RAISE EXCEPTION 'Runtime has unauthorized administrative privileges'; END IF;
 IF NOT EXISTS (SELECT 1 FROM agents a JOIN agent_versions v
   ON v.id=a.active_version_id AND v.agent_id=a.id
   WHERE a.agent_key='ancfz' AND v.provider='gemini' AND v.publication_state='published'
   AND v.knowledge_version_id IS NULL
   AND v.knowledge_status='awaiting_publication'
   AND v.foundry_agent_name IS NULL
   AND v.allowed_node_tools=ARRAY[
     'find_intents','select_ticket_intent','get_intent_requirements',
     'record_ticket_facts','get_offerings',
     'preflight_operation','propose_operation']::text[])
 THEN RAISE EXCEPTION 'Sara is not independently published without a fabricated store'; END IF;
 IF EXISTS(SELECT 1 FROM intent_catalog_versions v JOIN agents a ON a.id=v.agent_id
   WHERE a.agent_key='ancfz' AND v.status='published' AND v.source_authority<>'unapproved')
 THEN RAISE EXCEPTION 'Seed claimed commercial approval'; END IF;
END $preflight$;

INSERT INTO agents(id,agent_key,display_name,status) VALUES
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p2-gemini-a','P2 Agent A','active'),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','p2-gemini-b','P2 Agent B','active');

INSERT INTO gemini_knowledge_versions(agent_id,revision,store_resource_name,content_digest_sha256,approval_reference)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'fileSearchStores/p2-a',
repeat('a',64),'approved-reference-p2');
INSERT INTO gemini_knowledge_versions(agent_id,revision,store_resource_name,content_digest_sha256,approval_reference)
VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,'fileSearchStores/p2-b',
repeat('b',64),'approved-reference-p2');

INSERT INTO gemini_source_documents(agent_id,source_key,title,source_locator)
VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','source-a','Agent A source','private://a');
INSERT INTO gemini_source_documents(agent_id,source_key,title,source_locator)
VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','source-b','Agent B source','private://b');

INSERT INTO gemini_source_revisions(agent_id,document_id,revision,source_sha256,
 original_storage_ref,normalized_text_ref,approval_status,approval_reference,approved_at)
SELECT agent_id,id,1,repeat('c',64),'private://a/original','private://a/text',
'approved','review-a',clock_timestamp()
FROM gemini_source_documents WHERE source_key='source-a';
INSERT INTO gemini_source_revisions(agent_id,document_id,revision,source_sha256,
 original_storage_ref,normalized_text_ref,approval_status)
SELECT agent_id,id,1,repeat('d',64),'private://b/original','private://b/text','pending'
FROM gemini_source_documents WHERE source_key='source-b';

DO $cross_agent$
DECLARE bad boolean := false;
BEGIN
 BEGIN
  INSERT INTO gemini_source_revisions(agent_id,document_id,revision,source_sha256,
  original_storage_ref,normalized_text_ref)
  SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id,2,repeat('e',64),'x','y'
  FROM gemini_source_documents WHERE source_key='source-a';
 EXCEPTION WHEN foreign_key_violation THEN bad:=true;
 END;
 IF NOT bad THEN RAISE EXCEPTION 'Cross-agent revision FK not enforced'; END IF;
END $cross_agent$;

INSERT INTO gemini_knowledge_documents(agent_id,knowledge_version_id,
 document_id,document_version_id,provider_document_resource_name,index_status,indexed_at)
SELECT k.agent_id,k.id,r.document_id,r.id,'fileSearchStores/p2-a/documents/example','active',clock_timestamp()
FROM gemini_knowledge_versions k
JOIN gemini_source_revisions r ON r.agent_id=k.agent_id
WHERE k.agent_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

DO $approval_guard$
DECLARE failed boolean := false;
BEGIN
 BEGIN
  INSERT INTO gemini_knowledge_documents(agent_id,knowledge_version_id,
  document_id,document_version_id,provider_document_resource_name,index_status,indexed_at)
  SELECT k.agent_id,k.id,r.document_id,r.id,'fileSearchStores/p2-b/documents/example','active',clock_timestamp()
  FROM gemini_knowledge_versions k JOIN gemini_source_revisions r ON r.agent_id=k.agent_id
  WHERE k.agent_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 EXCEPTION WHEN others THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'Unapproved document could be activated'; END IF;
END $approval_guard$;

UPDATE gemini_knowledge_versions SET state='indexing'
WHERE agent_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE gemini_knowledge_versions SET state='verified'
WHERE agent_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
UPDATE gemini_knowledge_versions SET state='published'
WHERE agent_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
DO $pub$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM gemini_knowledge_versions
   WHERE agent_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
   AND state='published' AND published_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Approved knowledge did not publish'; END IF;
END $pub$;


DO $immutable_source$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  UPDATE gemini_source_revisions SET original_storage_ref='private://tampered'
   WHERE agent_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
     AND approval_status='approved';
 EXCEPTION WHEN others THEN blocked:=true;
 END;
 IF NOT blocked THEN
   RAISE EXCEPTION 'Approved source provenance changed after publication';
 END IF;
END $immutable_source$;

DO $unapproved_publish$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  UPDATE gemini_knowledge_versions SET state='indexing'
   WHERE agent_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  UPDATE gemini_knowledge_versions SET state='verified'
   WHERE agent_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  UPDATE gemini_knowledge_versions SET state='published'
   WHERE agent_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 EXCEPTION WHEN others THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'Unapproved knowledge was published'; END IF;
END $unapproved_publish$;

-- Row-level security must be enforced as agent_runtime, not only with SQL WHERE.
SET LOCAL ROLE agent_runtime;
SELECT set_config('app.agent_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
DO $rls_a$
BEGIN
 IF (SELECT count(*) FROM gemini_source_documents)<>1 OR
    (SELECT count(*) FROM gemini_knowledge_versions)<>1
 THEN RAISE EXCEPTION 'Agent A RLS leakage'; END IF;
END $rls_a$;
SELECT set_config('app.agent_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
DO $rls_b$
BEGIN
 IF (SELECT count(*) FROM gemini_source_documents)<>1 OR
    (SELECT count(*) FROM gemini_knowledge_versions)<>1
 THEN RAISE EXCEPTION 'Agent B RLS leakage'; END IF;
END $rls_b$;
SELECT set_config('app.agent_id','',true);
DO $rls_none$
BEGIN
 IF EXISTS(SELECT 1 FROM gemini_source_documents) OR
    EXISTS(SELECT 1 FROM gemini_knowledge_versions)
 THEN RAISE EXCEPTION 'Unscoped runtime RLS leakage'; END IF;
END $rls_none$;
RESET ROLE;
ROLLBACK;
\echo 'Gemini P2 PostgreSQL security, approval, provenance and RLS smoke passed (rolled back)'
