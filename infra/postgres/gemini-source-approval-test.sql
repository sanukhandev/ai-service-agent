-- Disposable-only regression: linked pending sources may be approved exactly
-- once, and their immutable provenance cannot be rewritten afterward.
BEGIN;
DO $test$
DECLARE
 a uuid;
 k uuid := gen_random_uuid();
 d uuid := gen_random_uuid();
 r uuid := gen_random_uuid();
 revision_no integer;
 rejected boolean;
BEGIN
 SELECT id INTO STRICT a FROM agents WHERE agent_key='ancfz';
 SELECT coalesce(max(revision),0)+1 INTO revision_no
   FROM gemini_knowledge_versions WHERE agent_id=a;
 INSERT INTO gemini_knowledge_versions(id,agent_id,revision)
   VALUES(k,a,revision_no);
 INSERT INTO gemini_source_documents(id,agent_id,source_key,title)
   VALUES(d,a,d::text,'Synthetic approval test source');
 INSERT INTO gemini_source_revisions(
   id,agent_id,document_id,revision,source_sha256,
   original_storage_ref,normalized_text_ref,normalized_text_sha256
 ) VALUES(
   r,a,d,1,repeat('a',64),
   '/app/approved-text/synthetic-test.txt',
   '/app/approved-text/synthetic-test.txt.verified.txt',repeat('b',64)
 );
 INSERT INTO gemini_knowledge_documents(
   agent_id,knowledge_version_id,document_id,document_version_id,
   source_name,source_mime
 ) VALUES(a,k,d,r,'synthetic-test.txt','text/plain');

 -- Existing linked record must not be deleted or silently rewritten.
 rejected:=false;
 BEGIN
   DELETE FROM gemini_source_revisions WHERE agent_id=a AND id=r;
 EXCEPTION WHEN OTHERS THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Linked source deletion was accepted'; END IF;

 UPDATE gemini_source_revisions
   SET approval_status='approved',
       approval_reference='TEST-REVIEWED-001',
       approved_at=clock_timestamp()
 WHERE agent_id=a AND id=r AND approval_status='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'Pending source approval failed'; END IF;

 rejected:=false;
 BEGIN
   UPDATE gemini_source_revisions
     SET approval_reference='UNAUTHORIZED-REWRITE' WHERE agent_id=a AND id=r;
 EXCEPTION WHEN OTHERS THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Approval reference mutation was accepted'; END IF;

 rejected:=false;
 BEGIN
   UPDATE gemini_source_revisions
     SET source_sha256=repeat('f',64) WHERE agent_id=a AND id=r;
 EXCEPTION WHEN OTHERS THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Approved source hash mutation was accepted'; END IF;

 rejected:=false;
 BEGIN
   UPDATE gemini_source_revisions
     SET approved_at=clock_timestamp()+interval '1 hour' WHERE agent_id=a AND id=r;
 EXCEPTION WHEN OTHERS THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Approval time rewrite was accepted'; END IF;

 UPDATE gemini_source_revisions
    SET approval_status='revoked' WHERE agent_id=a AND id=r;
 IF NOT FOUND THEN RAISE EXCEPTION 'Source revocation failed'; END IF;
 rejected:=false;
 BEGIN
   UPDATE gemini_source_revisions
     SET approval_status='approved' WHERE agent_id=a AND id=r;
 EXCEPTION WHEN OTHERS THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Revoked source reapproval was accepted'; END IF;
 RAISE NOTICE 'PASS: linked pending source approval, immutability, revocation';
END $test$;
ROLLBACK;
