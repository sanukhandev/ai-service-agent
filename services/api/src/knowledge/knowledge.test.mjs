import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {mkdtemp,writeFile,rm,readFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {validateSource,readSourceFile,zipEntries,expandApprovedArchive,withPrivateStage} from '../../dist/knowledge/intake.js';
import {KnowledgePublisher} from '../../dist/knowledge/publisher.js';
import {normalizedSourceText} from '../../dist/knowledge/normalizer.js';
import {GoogleFileSearchProvider,FileSearchError} from '../../dist/knowledge/provider.js';
const AGENT='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const VERSION='33333333-3333-4333-8333-333333333333',VERSION2='44444444-4444-4444-8444-444444444444';
const DOC='55555555-5555-4555-8555-555555555555',REV='66666666-6666-4666-8666-666666666666';
function mkzip(name,data){
  // Store-only zip fixture with a valid central directory, plus unix mode metadata.
  const n=Buffer.from(name), b=Buffer.from(data);
  const crc=(()=>{let c=-1;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0;})();
  const h=Buffer.alloc(30+n.length);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);n.copy(h,30);
  const d=Buffer.alloc(46+n.length);d.writeUInt32LE(0x02014b50,0);d.writeUInt16LE(0x031e,4);d.writeUInt16LE(20,6);d.writeUInt32LE(crc,16);d.writeUInt32LE(b.length,20);d.writeUInt32LE(b.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(((arguments[2]??0x81a4)<<16)>>>0,38);n.copy(d,46);
  const e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(1,8);e.writeUInt16LE(1,10);e.writeUInt32LE(d.length,12);e.writeUInt32LE(h.length+b.length,16);
  return Buffer.concat([h,b,d,e]);
}
class Repo {
  versions=new Map();docs=new Map();approvals=new Map();current=new Map();pins=new Map();rejectPublish=false;revokeCount=0;
  key(a,v){return a+':'+v;}
  async getVersion(a,v){return this.versions.get(this.key(a,v))??null;}
  async createDraft(a,v){if(this.versions.has(this.key(a,v)))throw Error('conflict');this.versions.set(this.key(a,v),{agentId:a,id:v,state:'draft',storeResourceName:null,contentDigestSha256:null,approvalReference:null,publishedAt:null});}
  async attachStore(a,v,store){const x=await this.getVersion(a,v);if(!x||x.storeResourceName&&x.storeResourceName!==store)throw Error('store conflict');x.storeResourceName=store;}
  async listDocuments(a,v){return [...this.docs.values()].filter(d=>d.agentId===a&&d.knowledgeVersionId===v);}
  async findByHash(a,v,h){return (await this.listDocuments(a,v)).find(x=>x.sha256===h)??null;}
  async saveDocument(d){if(this.docs.has(d.documentVersionId))throw Error('revision conflict');this.docs.set(d.documentVersionId,d);}
  async changeDocument(a,v,id,r,patch){const d=this.docs.get(r);if(!d||d.agentId!==a||d.knowledgeVersionId!==v||d.documentId!==id)throw Error('scope');Object.assign(d,patch);}
  async requireApproval(a,v,id,r){return this.approvals.get(this.key(a,r))??'';}
  async markVersion(a,v,state,digest){const x=await this.getVersion(a,v);x.state=state;if(digest)x.contentDigestSha256=digest;}
  async currentPublishedVersion(a){return this.current.get(a)??null;}
  async publishCAS(a,v,expected,binding){if(this.rejectPublish||await this.currentPublishedVersion(a)!==expected)return false;this.current.set(a,v);Object.assign(await this.getVersion(a,v),{state:'published',publishedAt:binding.publishedAt,approvalReference:binding.approvalReference});return true;}
  async pinnedActiveSessions(a,v){return this.pins.get(this.key(a,v))??0;}
  async retireIfUnpinned(a,v){if(await this.pinnedActiveSessions(a,v))return false;(await this.getVersion(a,v)).state='retired';return true;}
  async revoke(a,v,reason){(await this.getVersion(a,v)).state='revoked';if(this.current.get(a)===v)this.current.delete(a);this.revokeCount++;}
}
class Provider {
  docs=new Map();uploadCount=0;store='fileSearchStores/test-123';fail=false;pending=false;failOperation=false;listOverride=null;retrieveOverride=null;
  async createStore(){return this.store;}
  async getStore(){return {name:this.store,pendingDocumentsCount:'0',failedDocumentsCount:'0'};}
  async listDocuments(store){return this.listOverride??[...this.docs.values()].filter(x=>x.name.startsWith(store+'/documents/'));}
  async upload(store,source,metadata){this.uploadCount++;if(this.fail)throw new FileSearchError('rate_limit',true);const name=store+'/documents/doc-123';
    this.docs.set(name,{name,state:this.pending?'STATE_PENDING':'STATE_ACTIVE',customMetadata:Object.entries(metadata).map(([key,stringValue])=>({key,stringValue}))});
    return {name:store+'/upload/operations/op-123',done:!this.pending,error:this.failOperation?{code:500}:undefined,response:{documentName:name}};
  }
  async operation(name){return {name,done:true,error:this.failOperation?{code:500}:undefined,response:{documentName:this.store+'/documents/doc-123'}};}
  async getDocument(name){return this.docs.get(name)??{name,state:'STATE_FAILED'};}
  async retrieve(model,store,question){if(this.retrieveOverride)return this.retrieveOverride;return {text:question.includes('outside')?'INSUFFICIENT_APPROVED_KNOWLEDGE':'approved answer',documentResources:question.includes('outside')?[]:[store+'/documents/doc-123'],rawAnnotations:[]};}
  async deleteDocument(name){this.docs.delete(name);}
  async deleteStore(){}
}
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'p3-test-'));try{const db=new Repo(),google=new Provider(),pipeline=new KnowledgePublisher(db,google,join(root,'vault'),'gemini-3.5-flash');
 await pipeline.createDraft(AGENT,VERSION);const src=join(root,'source.txt');await writeFile(src,'Approved information about ANCFZ licensing.');
 return await run({db,google,pipeline,root,src});}finally{await rm(root,{recursive:true,force:true});}}
async function seeded(t){return fixture(async x=>{const d=await x.pipeline.receive(AGENT,VERSION,DOC,REV,x.src);x.db.approvals.set(x.db.key(AGENT,REV),'APPROVAL-001');await x.pipeline.approve(AGENT,VERSION,DOC,REV);return t({...x,d});});}
const probes=[{mode:'positive',question:'What is the approved licensing information?',expectedDocumentVersionIds:[REV]},{mode:'negative',question:'What does the outside secret document say?'}];

test('valid UTF-8 txt/markdown, hash stable, disallow empty and MIME mismatch',()=>{
 const a=validateSource('policy.txt',Buffer.from('A policy'));assert.equal(a.sha256.length,64);
 assert.equal(validateSource('policy.md',Buffer.from('A policy')).format,'md');
 assert.throws(()=>validateSource('policy.txt',Buffer.from('A'),'application/pdf'),/MIME_MISMATCH/);
 assert.throws(()=>validateSource('policy.txt',Buffer.alloc(0)),/SIZE/);
 assert.throws(()=>validateSource('evil.exe',Buffer.from('a')),/UNSUPPORTED/);
 assert.throws(()=>validateSource('x.pdf',Buffer.from('not pdf')),/INVALID_PDF/);
 assert.throws(()=>validateSource('x.txt',Buffer.from([0xff])),/INVALID_UTF8/);
});
test('safe ZIP member, archive-off by default, traversal, symlink, suspicious compression',()=>{
 const good=mkzip('inside.txt','Good data');assert.equal(zipEntries(good)[0].name,'inside.txt');
 assert.equal(expandApprovedArchive('batch.zip',good,true).length,1);
 assert.throws(()=>expandApprovedArchive('batch.zip',good),/ARCHIVE_DISABLED/);
 assert.throws(()=>zipEntries(mkzip('../escape.txt','bad')),/TRAVERSAL/);
 assert.throws(()=>zipEntries(mkzip('/etc/passwd','bad')),/TRAVERSAL/);
 const symlink=mkzip('link.txt','target');symlink.writeUInt32LE(0xa1ff0000,30+'link.txt'.length+'target'.length+38);
 assert.throws(()=>zipEntries(symlink),/UNSAFE_MEMBER/);
 const bomb=mkzip('x.txt','A');bomb.writeUInt32LE(50000000,30+'x.txt'.length+1+24);
 assert.throws(()=>zipEntries(bomb),/ZIP_BOMB/);
});
test('source filesystem symlink rejected and stage cleaned',async()=>fixture(async({root,src})=>{
 const link=join(root,'link.txt');await symlink(src,link);await assert.rejects(readSourceFile(link),/UNSAFE_FILE/);
 let stage;await withPrivateStage(async p=>{stage=p;await writeFile(join(p,'x'),'x');});await assert.rejects(readFile(join(stage,'x')));
}));
test('approval is a distinct trust gate; content deduplicates per version',async()=>fixture(async({pipeline,src})=>{
 await pipeline.receive(AGENT,VERSION,DOC,REV,src);
 await assert.rejects(pipeline.approve(AGENT,VERSION,DOC,REV),/APPROVAL_REQUIRED/);
 await assert.rejects(pipeline.receive(AGENT,VERSION,'other','other-rev',src),/DUPLICATE_CONTENT/);
 await assert.rejects(pipeline.index(AGENT,VERSION,DOC,REV),/APPROVAL_REQUIRED/);
}));
test('changed document hash can be ingested as new revision',async()=>fixture(async({pipeline,root,src})=>{
 await pipeline.receive(AGENT,VERSION,DOC,REV,src);
 const changed=join(root,'changed.txt');await writeFile(changed,'Revised approved instructions');
 const next=await pipeline.receive(AGENT,VERSION,DOC,'88888888-8888-4888-8888-888888888888',changed);
 assert.notEqual(next.sha256,(await readSourceFile(src)).sha256);
}));
test('indexes approved doc and resolves real exact evidence after publication',async()=>seeded(async({pipeline,google})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);
 const checked=await pipeline.verify(AGENT,VERSION,probes);assert.equal(checked.results.length,2);
 await pipeline.publish(AGENT,VERSION,null);
 const id=google.store+'/documents/doc-123';const evidence=await pipeline.resolveEvidence(AGENT,VERSION,id,'line 1','Approved information');
 assert.equal(evidence.documentVersionId,REV);assert.equal(evidence.sourceSha256.length,64);assert.equal(evidence.approvalStatus,'approved');
 await assert.rejects(pipeline.resolveEvidence(OTHER,VERSION,id,null,null),/VERSION_NOT_FOUND/);
 await assert.rejects(pipeline.resolveEvidence(AGENT,VERSION,google.store+'/documents/fabricated-123',null,null),/EVIDENCE_NOT_APPROVED/);
}));
test('cannot publish while pending, not active or after provider failure',async()=>seeded(async({pipeline,google,db})=>{
 google.pending=true;await assert.rejects(pipeline.index(AGENT,VERSION,DOC,REV),/PROVIDER_NOT_ACTIVE/);
 assert.equal(await db.currentPublishedVersion(AGENT),null);
}));
test('rate limit leaves uncertain import quarantined (no auto duplicate)',async()=>seeded(async({pipeline,google})=>{
 google.fail=true;await assert.rejects(pipeline.index(AGENT,VERSION,DOC,REV),e=>e.code==='rate_limit');
 google.fail=false;await assert.rejects(pipeline.index(AGENT,VERSION,DOC,REV),/UNCERTAIN_IMPORT/);
 assert.equal(google.uploadCount,1);
}));
test('reconciles an interrupted upload through exact metadata without reimport',async()=>seeded(async({pipeline,google,db})=>{
 const file=(await db.listDocuments(AGENT,VERSION))[0];const name=google.store+'/documents/doc-123';
 google.docs.set(name,{name,state:'STATE_ACTIVE',customMetadata:[{key:'documentId',stringValue:DOC},{key:'documentVersionId',stringValue:REV}]});
 await db.changeDocument(AGENT,VERSION,DOC,REV,{status:'indexing'});
 await pipeline.index(AGENT,VERSION,DOC,REV);assert.equal(google.uploadCount,0);
}));
test('rejects wrong store and foreign/fabricated provider documents',async()=>seeded(async({pipeline,google,db})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);
 const d=(await db.listDocuments(AGENT,VERSION))[0];
 await db.changeDocument(AGENT,VERSION,DOC,REV,{providerDocumentName:'fileSearchStores/alien-123/documents/doc-123'});
 await assert.rejects(pipeline.verify(AGENT,VERSION,probes),e=>e.code==='invalid');
 await db.changeDocument(AGENT,VERSION,DOC,REV,{providerDocumentName:d.providerDocumentName.replace('alien','test')});
}));
test('wrong provider metadata rejects a fake source even when title matches',async()=>seeded(async({pipeline,google})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);
 google.docs.get(google.store+'/documents/doc-123').customMetadata[0].stringValue=OTHER;
 await assert.rejects(pipeline.verify(AGENT,VERSION,probes),/SOURCE_MAPPING_MISMATCH/);
}));
test('retrieval negative suite prevents publication of overbroad results',async()=>seeded(async({pipeline,google,db})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);
 google.retrieveOverride={text:'unsafe',documentResources:[google.store+'/documents/doc-123'],rawAnnotations:[]};
 await assert.rejects(pipeline.verify(AGENT,VERSION,probes),/NEGATIVE_SMOKE_FAILED/);
 await assert.rejects(pipeline.publish(AGENT,VERSION,null),/VERSION_NOT_VERIFIED/);
 assert.equal(await db.currentPublishedVersion(AGENT),null);
}));
test('partial failure and publish CAS rollback keep old binding',async()=>seeded(async({pipeline,db})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);await pipeline.verify(AGENT,VERSION,probes);
 db.current.set(AGENT,VERSION2);await assert.rejects(pipeline.publish(AGENT,VERSION,null),/PUBLICATION_CONFLICT/);
 assert.equal(await db.currentPublishedVersion(AGENT),VERSION2);
}));
test('pinned sessions block retirement and remain pinned across version publish',async()=>seeded(async({pipeline,db})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);await pipeline.verify(AGENT,VERSION,probes);
 db.current.set(AGENT,VERSION2);db.pins.set(db.key(AGENT,VERSION),1);
 await assert.rejects(pipeline.retire(AGENT,VERSION),/PINNED_SESSIONS/);
 assert.equal(await db.currentPublishedVersion(AGENT),VERSION2);
 db.pins.set(db.key(AGENT,VERSION),0);await pipeline.retire(AGENT,VERSION);
}));
test('revocation removes current binding authorization and historical metadata remains',async()=>seeded(async({pipeline,db})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);await pipeline.verify(AGENT,VERSION,probes);await pipeline.publish(AGENT,VERSION,null);
 await pipeline.revoke(AGENT,VERSION,'obsolete policy');assert.equal(await db.currentPublishedVersion(AGENT),null);
 await assert.rejects(pipeline.resolveEvidence(AGENT,VERSION,'fileSearchStores/test-123/documents/doc-123',null,null),/VERSION_NOT_PUBLISHED/);
 assert.equal(db.revokeCount,1);assert.equal((await db.listDocuments(AGENT,VERSION)).length,1);
}));
test('Google transport validates resource names and blocks forged resumable-upload host',async()=>{
 let call=0;const fetcher=async()=>{call++;return {ok:true,status:200,headers:new Headers({'x-goog-upload-url':'https://evil.example/upload/x'})}};
 const google=new GoogleFileSearchProvider('test-key',fetcher,1);
 await assert.rejects(google.upload('fileSearchStores/test-123',validateSource('a.txt',Buffer.from('approved')),{agentId:AGENT}),/FILE_SEARCH_PROVIDER/);
 assert.equal(call,1);
 await assert.rejects(google.getStore('bad/other'),/FILE_SEARCH_INVALID/);
});
test('Google provider classifies 429, fails closed on unknown annotation identity',async()=>{
 let i=0;const fetcher=async(url,init)=>{i++;if(i===1)return {ok:false,status:429};
   return {ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:'some response'}]},groundingMetadata:{groundingChunks:[{retrievedContext:{title:'policy.txt'}}]}}]})};};
 const google=new GoogleFileSearchProvider('key',fetcher,1);
 await assert.rejects(google.getStore('fileSearchStores/test-123'),e=>e.code==='rate_limit');
 const answer=await google.retrieve('gemini-3.5-flash','fileSearchStores/test-123','policy?');assert.deepEqual(answer.documentResources,[]);
});

test('valid minimal PDF and OOXML DOCX, rejects malformed DOCX',()=>{
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF');
 assert.equal(validateSource('policy.pdf',pdf).format,'pdf');
 const docx=(()=>{
   const names=[['[Content_Types].xml','<Types/>'],['word/document.xml','<w:document><w:body><w:p><w:r><w:t>Approved passage</w:t></w:r></w:p></w:body></w:document>']];
   const parts=[],dirs=[];let offset=0;
   for(const [name,content] of names){const n=Buffer.from(name),b=Buffer.from(content);let crc=-1;for(const x of b){crc^=x;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^-1)>>>0;
     const h=Buffer.alloc(30+n.length);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);n.copy(h,30);parts.push(h,b);
     const d=Buffer.alloc(46+n.length);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt32LE(crc,16);d.writeUInt32LE(b.length,20);d.writeUInt32LE(b.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);n.copy(d,46);dirs.push(d);offset+=h.length+b.length;
   }
   const directory=Buffer.concat(dirs),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(2,8);end.writeUInt16LE(2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
   return Buffer.concat([...parts,directory,end]);
 })();
 assert.equal(validateSource('policy.docx',docx).format,'docx');
 assert.throws(()=>validateSource('fake.docx',mkzip('inside.txt','irrelevant')),/INVALID_DOCX/);
});
test('failed indexing operation does not advance publication',async()=>seeded(async({pipeline,google,db})=>{
 google.failOperation=true;
 await assert.rejects(pipeline.index(AGENT,VERSION,DOC,REV),/INDEX_FAILED/);
 assert.equal(await db.currentPublishedVersion(AGENT),null);
}));
test('foreign extra provider document prevents verification',async()=>seeded(async({pipeline,google})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);
 const foreign=google.store+'/documents/foreign-123';google.docs.set(foreign,{name:foreign,state:'STATE_ACTIVE',customMetadata:[]});
 await assert.rejects(pipeline.verify(AGENT,VERSION,probes),/UNAPPROVED_PROVIDER_DOCUMENT/);
}));
test('irreversible deletion requires explicit confirmation, retired state and no pinned sessions',async()=>seeded(async({pipeline,google,db})=>{
 await pipeline.index(AGENT,VERSION,DOC,REV);await pipeline.verify(AGENT,VERSION,probes);await pipeline.publish(AGENT,VERSION,null);
 await assert.rejects(pipeline.deleteRetiredStore(AGENT,VERSION,'delete'),/DELETE_CONFIRMATION_REQUIRED/);
 const correct=`DELETE:${AGENT}:${VERSION}`;
 await assert.rejects(pipeline.deleteRetiredStore(AGENT,VERSION,correct),/DELETE_REQUIRES_RETIREMENT/);
 db.current.set(AGENT,VERSION2);db.pins.set(db.key(AGENT,VERSION),1);await db.markVersion(AGENT,VERSION,'retired');
 await assert.rejects(pipeline.deleteRetiredStore(AGENT,VERSION,correct),/DELETE_PINNED_OR_ACTIVE/);
 db.pins.set(db.key(AGENT,VERSION),0);await pipeline.deleteRetiredStore(AGENT,VERSION,correct);
 assert.equal(google.docs.size,0);assert.equal((await db.listDocuments(AGENT,VERSION)).length,1);
}));
test('provider timeout is classified as retryable',async()=>{
 const fetcher=async()=>{throw new Error('connection lost');};
 const p=new GoogleFileSearchProvider('private-key',fetcher,1);
 await assert.rejects(p.getStore('fileSearchStores/test-123'),e=>e.code==='timeout'&&e.retryable===true);
});


test('real provider transport resolves exact ACTIVE File Search document using matching citation metadata',async()=>{
 const store='fileSearchStores/test-123';
 const metadata={
   agentId:AGENT,knowledgeVersionId:VERSION,documentId:DOC,
   documentVersionId:REV,sha256:'b'.repeat(64),
 };
 const listed={name:store+'/documents/doc-123',state:'STATE_ACTIVE',
   customMetadata:Object.entries(metadata).map(([key,stringValue])=>({key,stringValue}))};
 const fetcher=async(url,init)=>{
   if(String(url).includes(':generateContent'))return new Response(JSON.stringify({
     candidates:[{content:{parts:[{text:'The synthetic approved policy has seven seals.'}]},
       groundingMetadata:{groundingChunks:[{retrievedContext:{
         fileSearchStore:store,title:'Synthetic test policy',
         text:'The synthetic approved policy has seven seals.',
         customMetadata:Object.entries(metadata).map(([key,stringValue])=>({key,stringValue})),
       }}]}}],
   }),{status:200,headers:{'content-type':'application/json'}});
   if(String(url).includes('/documents'))return new Response(JSON.stringify({documents:[listed]}),
     {status:200,headers:{'content-type':'application/json'}});
   throw Error('Unexpected provider endpoint '+url);
 };
 const provider=new GoogleFileSearchProvider('test-only-key',fetcher,1);
 const result=await provider.retrieve('gemini-3.8-flash',store,'What does the approved document say?');
 assert.deepEqual(result.documentResources,[listed.name]);
 assert.equal(result.rawAnnotations.length,1);
});



test("approved TXT, DOCX and text PDF normalize deterministically; unverified binary rejected",async()=>{
  assert.equal(await normalizedSourceText(Buffer.from(" Policy text \r\n","utf8"),"text/plain"),"Policy text");
  const docx=Buffer.from("UEsDBBQAAAAIAGWWbl3y7KMrdgAAAIwAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbCWOSw7CMAxErxJlD65YsKiSbIAbcAErcj8iH6txpXJ7nLKceTP2uPeXqZkjp9K8XUR4BGhxoYztWpmKkqluGUXlNgNj/OBMcBuGO8RahIpcpN+wwT1pwj2JeR1qt7UWb7VuzeOf66+8Rea0RhTF0CkEB+eI8ANQSwMEFAAAAAgAZZZuXdJvbvStAAAA6QAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOSQ7CMAxFr2JlwY6msECodFjBCeAAITWlIokjJ3S4PQks2DzL+vbTr7vFGpiQw0iuEbuiFIBOUz+6oRG362V7FF1bz1VP+m3RRUj3LlRzI54x+krKoJ9oVSjIo0vZg9iqmFYe5EzceyaNISSdNXJflgdp1ehEVt6pX/P0GZwR2/OidDQrxBnNhKDJe2R4GDUE2CjrT0AOIYwpZHjhWtQyv2Xyl/7Ln1r+a7cfUEsBAhQDFAAAAAgAZZZuXfLsoyt2AAAAjAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACABllm5d0m9u9K0AAADpAAAAEQAAAAAAAAAAAAAAgAGnAAAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAIAAgCAAAAAgwEAAAAA","base64");
  const extracted=await normalizedSourceText(docx,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.match(extracted,/Exactly twelve copper flags & one silver key/);
  const pdf=Buffer.from("JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCAzMDAgMjUwIF0gL1BhcmVudCA2IDAgUiAvUmVzb3VyY2VzIDw8Ci9Gb250IDEgMCBSIC9Qcm9jU2V0IFsgL1BERiAvVGV4dCAvSW1hZ2VCIC9JbWFnZUMgL0ltYWdlSSBdCj4+IC9Sb3RhdGUgMCAvVHJhbnMgPDwKCj4+IAogIC9UeXBlIC9QYWdlCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9QYWdlTW9kZSAvVXNlTm9uZSAvUGFnZXMgNiAwIFIgL1R5cGUgL0NhdGFsb2cKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL0F1dGhvciAoYW5vbnltb3VzKSAvQ3JlYXRpb25EYXRlIChEOjIwMjYxMTE0MTg1MTExKzAwJzAwJykgL0NyZWF0b3IgKGFub255bW91cykgL0tleXdvcmRzICgpIC9Nb2REYXRlIChEOjIwMjYxMTE0MTg1MTExKzAwJzAwJykgL1Byb2R1Y2VyIChSZXBvcnRMYWIgUERGIExpYnJhcnkgLSBcKG9wZW5zb3VyY2VcKSkgCiAgL1N1YmplY3QgKHVuc3BlY2lmaWVkKSAvVGl0bGUgKHVudGl0bGVkKSAvVHJhcHBlZCAvRmFsc2UKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL0NvdW50IDEgL0tpZHMgWyAzIDAgUiBdIC9UeXBlIC9QYWdlcwo+PgplbmRvYmoKNyAwIG9iago8PAovRmlsdGVyIFsgL0FTQ0lJODVEZWNvZGUgL0ZsYXRlRGVjb2RlIF0gL0xlbmd0aCAxNDYKPj4Kc3RyZWFtCkdhcEBFMGIvZSMnRXJoWTByN3RwVDU3cVFVKHVlKSEkVTcoXGZnRyMtSlZvUWpzPHIiLTtVU0xhaiw/Z01mUUI4ZFwoZyY8PVdsVkM5YCdbVmk9J2gyKixkKV8rPG4hJSg+ciZEUCNsPUdDYUdyTyxvVTJAK2NsaSYoci4mPj5uT3ImK29Zb1YiYiJpRVsjXX4+ZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDA5MiAwMDAwMCBuIAowMDAwMDAwMTk5IDAwMDAwMCBuIAowMDAwMDAzOTIgMDAwMDAgbiAKMDAwMDAwMDQ2MCAwMDAwMCBuIAowMDAwMDAwNzIxIDAwMDAwMCBuIAowMDAwMDA3ODAgMDAwMDAgbiAKdHJhaWxlcgo8PAovSUQgCls8YjUxODFjMWMyMzc5YWQwMjA0YTRjYzQ1ZmFjNzFlNjc+PGI1MTgxYzFjMjM3OWFkMDIwNGE0Y2M0NWZhYzcxZTY3Pl0KJSBSZXBvcnRMYWIgZ2VuZXJhdGVkIFBERiBkb2N1bWVudCAtLSBkaWdlc3QgKG9wZW5zb3VyY2UpCgovSW5mbyA1IDAgUgovUm9vdCA0IDAgUgovU2l6ZSA4Cj4+CnN0YXJ0eHJlZgoxMDE2CiUlRU9GCg==","base64");
  const fromPdf=await normalizedSourceText(pdf,"application/pdf");
  assert.match(fromPdf,/eleven silver keys/);
  await assert.rejects(normalizedSourceText(Buffer.from(""),"application/pdf"),
    /KNOWLEDGE_UNSAFE_SOURCE_SIZE/);
});


test('File Search accepts a pending upload operation with omitted done, then polls to completion',async()=>{
  const store='fileSearchStores/test-123',name=store+'/upload/operations/op-123';
  const endpoint='https://generativelanguage.googleapis.com';
  const uploadUrl=endpoint+'/upload/v1beta/fileSearchStores/test-123:uploadToFileSearchStore?upload_id=mock';
  const source=validateSource('sample.txt',Buffer.from('Synthetic approved text'));
  const metadata={agentId:AGENT,documentVersionId:REV};
  const seen=[];
  const fetcher=async(url,init)=>{
    seen.push(String(url));
    if(String(url)===endpoint+'/upload/v1beta/'+store+':uploadToFileSearchStore'){
      assert.equal(init.method,'POST');
      assert.equal(init.headers['x-goog-upload-command'],'start');
      assert.deepEqual(JSON.parse(init.body).customMetadata,
        Object.entries(metadata).map(([key,stringValue])=>({key,stringValue})));
      return new Response(null,{status:200,headers:{'x-goog-upload-url':uploadUrl}});
    }
    if(String(url)===uploadUrl){
      assert.equal(init.headers['x-goog-upload-command'],'upload, finalize');
      assert.equal(Buffer.from(init.body).toString('utf8'),'Synthetic approved text');
      return new Response(JSON.stringify({name}),{status:200});
    }
    if(String(url)===endpoint+'/v1beta/'+name){
      return new Response(JSON.stringify({name,done:true,response:{
        documentName:store+'/documents/doc-123'
      }}),{status:200});
    }
    throw Error('Unexpected request');
  };
  const google=new GoogleFileSearchProvider('synthetic-test-key',fetcher,1);
  const pending=await google.upload(store,source,metadata);
  assert.deepEqual(pending,{name,done:false});
  const completed=await google.operation(pending.name);
  assert.equal(completed.done,true);
  assert.equal(completed.response.documentName,store+'/documents/doc-123');
  assert.equal(seen.length,3);
});

test('File Search polling treats missing done as pending and preserves provider errors',async()=>{
  const name='fileSearchStores/test-123/upload/operations/op-123';
  const responses=[{name},{name,done:true,error:{code:500,message:'Synthetic indexing failure'}}];
  const fetcher=async()=>new Response(JSON.stringify(responses.shift()),{status:200});
  const google=new GoogleFileSearchProvider('synthetic-test-key',fetcher,1);
  assert.deepEqual(await google.operation(name),{name,done:false});
  const failed=await google.operation(name);
  assert.equal(failed.done,true);
  assert.equal(failed.error.code,500);
});

test('File Search rejects malformed operation names and done types without accepting indexing',async()=>{
  const store='fileSearchStores/test-123',name=store+'/upload/operations/op-123';
  const uploadUrl='https://generativelanguage.googleapis.com/upload/v1beta/upload-session';
  const source=validateSource('sample.txt',Buffer.from('Synthetic approved text'));
  for(const body of [null,{}, {name:'other-store/operations/op-123'}, {name,done:'false'}, {name,done:0}]){
    let calls=0;
    const fetcher=async()=>++calls===1
      ?new Response(null,{status:200,headers:{'x-goog-upload-url':uploadUrl}})
      :new Response(JSON.stringify(body),{status:200});
    const google=new GoogleFileSearchProvider('synthetic-test-key',fetcher,1);
    await assert.rejects(google.upload(store,source,{}),e=>
      e instanceof FileSearchError&&e.code==='provider'&&e.retryable===false);
    assert.equal(calls,2);
  }
  const badPoll=new GoogleFileSearchProvider('synthetic-test-key',
    async()=>new Response(JSON.stringify({name,done:'true'}),{status:200}),1);
  await assert.rejects(badPoll.operation(name),/FILE_SEARCH_PROVIDER/);
});


test('long DOCX source normalizes without truncation and remains bounded',async()=>{
  const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // Exercise multiple Word paragraphs so the cumulative counter, not a repeated
  // full document join, enforces the normalized evidence limit.
  const content=Array.from({length:12},(_,i)=>'Section '+i+': '+'A'.repeat(20000));
  const xml='<w:document><w:body>'+content.map(p=>
    '<w:p><w:r><w:t>'+p+'</w:t></w:r></w:p>').join('')+'</w:body></w:document>';
  const docx=mkzip('word/document.xml',xml);
  const expected=content.join('\n');
  assert.ok(expected.length>200000);
  assert.ok(expected.length<1000000);
  const extracted=await normalizedSourceText(docx,mime);
  assert.equal(extracted,expected);
  assert.equal(extracted.length,expected.length);

  // Both text and DOCX must still reject sources over the expanded hard cap.
  const cap=1000000;
  assert.equal((await normalizedSourceText(Buffer.from('B'.repeat(cap)), 'text/plain')).length,cap);
  await assert.rejects(
    normalizedSourceText(Buffer.from('B'.repeat(cap+1)), 'text/plain'),
    /KNOWLEDGE_NORMALIZED_TEXT_TOO_LARGE/
  );
  const oversized=mkzip('word/document.xml',
    '<w:document><w:body><w:p><w:t>'+'C'.repeat(cap+1)+
    '</w:t></w:p></w:body></w:document>');
  await assert.rejects(normalizedSourceText(oversized,mime),
    /KNOWLEDGE_NORMALIZED_TEXT_TOO_LARGE/);
});


test('operator validate preflight enforces normalization limits before staging',async()=>{
  const {spawnSync}=await import('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'gemini-normalization-preflight-'));
  try{
    const valid=join(root,'large-approved.txt');
    await writeFile(valid,'D'.repeat(220000));
    const pass=spawnSync(process.execPath,['scripts/ingest-agent-knowledge.mjs','validate',valid],
      {encoding:'utf8'});
    assert.equal(pass.status,0,pass.stderr);
    const parsed=JSON.parse(pass.stdout);
    assert.equal(parsed.sources[0].normalizedCharacters,220000);
    assert.equal(parsed.sources[0].bytes,220000);
    const oversized=join(root,'oversized.txt');
    await writeFile(oversized,'E'.repeat(1000001));
    const fail=spawnSync(process.execPath,['scripts/ingest-agent-knowledge.mjs','validate',oversized],
      {encoding:'utf8'});
    assert.notEqual(fail.status,0);
    assert.match(fail.stderr,/KNOWLEDGE_NORMALIZED_TEXT_TOO_LARGE/);
  }finally{await rm(root,{recursive:true,force:true});}
});
