import {createHash} from 'node:crypto';
import {readSourceFile, retainOriginal, withPrivateStage, type ValidatedSource} from './intake.js';
import {assertDocumentName,assertStoreName,type FileSearchProvider,type IndexOperation,type Retrieval} from './provider.js';

export type DocumentStatus='received'|'validated'|'awaiting_approval'|'approved'|'indexing'|'indexed'|'verified'|'published'|'failed'|'retired'|'revoked';
export type VersionStatus='draft'|'indexing'|'verified'|'published'|'retired'|'revoked';
export type DocumentRecord={agentId:string;knowledgeVersionId:string;documentId:string;documentVersionId:string;name:string;sha256:string;mime:string;originalPath:string;required:boolean;status:DocumentStatus;approvalReference:string|null;operationName:string|null;providerDocumentName:string|null};
export type VersionRecord={agentId:string;id:string;state:VersionStatus;storeResourceName:string|null;contentDigestSha256:string|null;approvalReference:string|null;publishedAt:string|null};
/** P2 must implement these with agent-scoped transactions, composite FKs/RLS and CAS. */
export interface KnowledgeRepository {
  getVersion(agentId:string,id:string):Promise<VersionRecord|null>;
  createDraft(agentId:string,id:string):Promise<void>;
  attachStore(agentId:string,id:string,store:string):Promise<void>;
  listDocuments(agentId:string,versionId:string):Promise<DocumentRecord[]>;
  findByHash(agentId:string,versionId:string,sha256:string):Promise<DocumentRecord|null>;
  saveDocument(record:DocumentRecord):Promise<void>;
  changeDocument(agentId:string,versionId:string,documentId:string,documentVersionId:string,patch:Partial<DocumentRecord>):Promise<void>;
  /** Must query an independently authorized, recorded human approval; CLI flags are insufficient. */
  requireApproval(agentId:string,versionId:string,documentId:string,documentVersionId:string):Promise<string>;
  markVersion(agentId:string,versionId:string,state:VersionStatus,contentDigest?:string):Promise<void>;
  /** Atomic CAS: prevents conflicting publishes, never changes bindings on failure. */
  publishCAS(agentId:string,versionId:string,expectedCurrentId:string|null,binding:{agentId:string;knowledgeVersionId:string;provider:'gemini_file_search';storeResourceName:string;state:'published';contentDigestSha256:string;approvalReference:string|null;publishedAt:string}):Promise<boolean>;
  currentPublishedVersion(agentId:string):Promise<string|null>;
  pinnedActiveSessions(agentId:string,versionId:string):Promise<number>;
  retireIfUnpinned(agentId:string,versionId:string):Promise<boolean>;
  /** Transactional deny check must be checked before every customer-facing retrieval. */
  revoke(agentId:string,versionId:string,reason:string):Promise<void>;
}
export type SmokeCase={question:string;expectedDocumentVersionIds?:string[];mode:'positive'|'negative'};
export class KnowledgeError extends Error { constructor(readonly code:string) {super('KNOWLEDGE_'+code);} }
const must=(ok:unknown,code:string):asserts ok=>{if(!ok)throw new KnowledgeError(code);};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const storeScope=(store:string)=>{assertStoreName(store);return store;};
const documentScope=(store:string,id:string)=>{assertDocumentName(store,id);return id;};
export class KnowledgePublisher {
  constructor(private readonly db:KnowledgeRepository,private readonly google:FileSearchProvider,private readonly originalsRoot:string,private readonly model:string) {}
  private async version(agentId:string,versionId:string):Promise<VersionRecord> {
    const v=await this.db.getVersion(agentId,versionId);if(!v)throw new KnowledgeError('VERSION_NOT_FOUND');return v;
  }
  async createDraft(agentId:string,versionId:string):Promise<VersionRecord> {
    await this.db.createDraft(agentId,versionId);return this.version(agentId,versionId);
  }
  /** Creating a store is a privileged operation; same store cannot be shared between versions. */
  async ensureStore(agentId:string,versionId:string):Promise<string> {
    const v=await this.version(agentId,versionId);
    if(v.state!=='draft'&&v.state!=='indexing')throw new KnowledgeError('VERSION_LOCKED');
    if(v.storeResourceName)return storeScope(v.storeResourceName);
    const store=storeScope(await this.google.createStore(`agent-${agentId}-knowledge-${versionId}`));
    await this.db.attachStore(agentId,versionId,store);
    return store;
  }
  async receive(agentId:string,versionId:string,documentId:string,documentVersionId:string,path:string,required=true):Promise<DocumentRecord> {
    const v=await this.version(agentId,versionId);
    if(v.state!=='draft')throw new KnowledgeError('VERSION_LOCKED');
    return withPrivateStage(async()=>{
      const file=await readSourceFile(path);
      const existing=await this.db.findByHash(agentId,versionId,file.sha256);
      if(existing)throw new KnowledgeError('DUPLICATE_CONTENT');
      // Keep the original for independent P4 verification, not in customer ticket uploads.
      const originalPath=await retainOriginal(this.originalsRoot,agentId,versionId,file);
      const record:DocumentRecord={agentId,knowledgeVersionId:versionId,documentId,documentVersionId,
        name:file.name,sha256:file.sha256,mime:file.mime,originalPath,required,
        status:'awaiting_approval',approvalReference:null,operationName:null,providerDocumentName:null};
      await this.db.saveDocument(record);return record;
    });
  }
  async approve(agentId:string,versionId:string,documentId:string,documentVersionId:string):Promise<DocumentRecord> {
    const d=await this.document(agentId,versionId,documentId,documentVersionId);
    if(d.status!=='awaiting_approval'&&d.status!=='approved')throw new KnowledgeError('BAD_APPROVAL_STATE');
    const approval=await this.db.requireApproval(agentId,versionId,documentId,documentVersionId);
    if(!approval)throw new KnowledgeError('APPROVAL_REQUIRED');
    await this.db.changeDocument(agentId,versionId,documentId,documentVersionId,{status:'approved',approvalReference:approval});
    return this.document(agentId,versionId,documentId,documentVersionId);
  }
  private async document(agentId:string,versionId:string,id:string,revision:string):Promise<DocumentRecord> {
    const record=(await this.db.listDocuments(agentId,versionId)).find(x=>x.documentId===id&&x.documentVersionId===revision);
    if(!record)throw new KnowledgeError('DOCUMENT_NOT_FOUND');return record;
  }
  private async poll(op:IndexOperation,timeoutMs=60000):Promise<IndexOperation> {
    const started=Date.now();let current=op;
    while(!current.done&&Date.now()-started<timeoutMs){await new Promise(resolve=>setTimeout(resolve,Math.min(800,timeoutMs)));current=await this.google.operation(current.name);}
    if(!current.done)throw new KnowledgeError('INDEX_TIMEOUT');
    if(current.error)throw new KnowledgeError('INDEX_FAILED');
    return current;
  }
  /** Resumable: document or operation recorded before crash is inspected; never blindly re-upload. */
  async index(agentId:string,versionId:string,id:string,revision:string):Promise<DocumentRecord> {
    const v=await this.version(agentId,versionId);
    if(!['draft','indexing'].includes(v.state))throw new KnowledgeError('VERSION_LOCKED');
    const store=await this.ensureStore(agentId,versionId);
    let d=await this.document(agentId,versionId,id,revision);
    if(!d.approvalReference||!['approved','indexing','indexed'].includes(d.status))throw new KnowledgeError('APPROVAL_REQUIRED');
    if(d.providerDocumentName) {
      const pd=await this.google.getDocument(documentScope(store,d.providerDocumentName));
      if(pd.state!=='STATE_ACTIVE')throw new KnowledgeError('PROVIDER_NOT_ACTIVE');
      return d;
    }
    let op:IndexOperation;
    if(d.operationName) {
      op=await this.google.operation(d.operationName);
    } else {
      // Handle lost operation response from a previous attempt conservatively:
      // any document with exact immutable scope metadata can be recovered, not by title.
      const matches=(await this.google.listDocuments(store)).filter(x=>x.customMetadata?.some(m=>m.key==='documentVersionId'&&m.stringValue===revision) && x.customMetadata?.some(m=>m.key==='documentId'&&m.stringValue===id));
      if(matches.length>1)throw new KnowledgeError('AMBIGUOUS_PROVIDER_RECOVERY');
      if(matches.length===1){
        const pd=matches[0];documentScope(store,pd.name);
        if(pd.state!=='STATE_ACTIVE')throw new KnowledgeError('RECOVERY_PENDING');
        await this.db.changeDocument(agentId,versionId,id,revision,{providerDocumentName:pd.name,status:'indexed'});
        return this.document(agentId,versionId,id,revision);
      }
      if(d.status==='indexing')throw new KnowledgeError('UNCERTAIN_IMPORT_REQUIRES_RECONCILIATION');
      await this.db.changeDocument(agentId,versionId,id,revision,{status:'indexing'});
      await this.db.markVersion(agentId,versionId,'indexing');
      // No uploader may read an untrusted filename from a model.
      const file=await readSourceFile(d.originalPath,d.mime);
      if(file.sha256!==d.sha256)throw new KnowledgeError('ORIGINAL_TAMPERED');
      op=await this.google.upload(store,file,{agentId,knowledgeVersionId:versionId,documentId:id,documentVersionId:revision,sha256:d.sha256});
      if(!op.name)throw new KnowledgeError('OPERATION_MISSING');
      await this.db.changeDocument(agentId,versionId,id,revision,{operationName:op.name});
    }
    op=await this.poll(op);
    if(!op.response?.documentName)throw new KnowledgeError('DOCUMENT_ID_MISSING');
    const providerId=documentScope(store,op.response.documentName);
    const pd=await this.google.getDocument(providerId);
    if(pd.state!=='STATE_ACTIVE')throw new KnowledgeError('PROVIDER_NOT_ACTIVE');
    await this.db.changeDocument(agentId,versionId,id,revision,{status:'indexed',providerDocumentName:providerId});
    return this.document(agentId,versionId,id,revision);
  }
  private async verifiedDocs(agentId:string,versionId:string):Promise<{version:VersionRecord;docs:DocumentRecord[];store:string;digest:string}> {
    const version=await this.version(agentId,versionId);
    const store=storeScope(version.storeResourceName??'');
    const docs=await this.db.listDocuments(agentId,versionId);
    if(!docs.length||docs.some(d=>!d.approvalReference||!d.providerDocumentName||!['indexed','verified'].includes(d.status)))throw new KnowledgeError('INCOMPLETE_APPROVAL_OR_INDEX');
    const providerList=await this.google.listDocuments(store);
    const storeState=await this.google.getStore(store);
    if(storeState.name!==store||Number(storeState.pendingDocumentsCount??0)>0||Number(storeState.failedDocumentsCount??0)>0)throw new KnowledgeError('STORE_NOT_READY');
    if(providerList.length!==docs.length||new Set(providerList.map(p=>p.name)).size!==providerList.length)throw new KnowledgeError('UNAPPROVED_PROVIDER_DOCUMENT');
    for(const d of docs){
      const id=documentScope(store,d.providerDocumentName!);
      const found=providerList.find(p=>p.name===id);
      if(!found||found.state!=='STATE_ACTIVE')throw new KnowledgeError('PROVIDER_NOT_ACTIVE');
      const meta=Object.fromEntries((found.customMetadata??[]).map(x=>[x.key,x.stringValue]));
      if(meta.agentId!==agentId||meta.knowledgeVersionId!==versionId||meta.documentId!==d.documentId||meta.documentVersionId!==d.documentVersionId||meta.sha256!==d.sha256)throw new KnowledgeError('SOURCE_MAPPING_MISMATCH');
      const original=await readSourceFile(d.originalPath,d.mime);
      if(original.sha256!==d.sha256)throw new KnowledgeError('ORIGINAL_TAMPERED');
    }
    const digest=sha(docs.map(x=>x.documentVersionId+':'+x.sha256).sort().join('\n'));
    return {version,docs,store,digest};
  }
  async verify(agentId:string,versionId:string,cases:SmokeCase[]):Promise<{digest:string;results:{mode:string;citations:string[]}[]}> {
    const {version,docs,store,digest}=await this.verifiedDocs(agentId,versionId);
    if(!cases.length||!cases.some(x=>x.mode==='positive')||!cases.some(x=>x.mode==='negative'))throw new KnowledgeError('SMOKE_REQUIRED');
    const result=[];
    for(const c of cases){
      if(!c.question.trim())throw new KnowledgeError('INVALID_SMOKE');
      const retrieval=await this.google.retrieve(this.model,store,c.mode==='negative'?`${c.question}\nIf the approved store does not support the answer, return exactly INSUFFICIENT_APPROVED_KNOWLEDGE and do not invent facts.`:c.question);
      if(c.mode==='negative'){
        if(retrieval.documentResources.length||!retrieval.text.includes('INSUFFICIENT_APPROVED_KNOWLEDGE'))throw new KnowledgeError('NEGATIVE_SMOKE_FAILED');
      }else{
        if(!retrieval.documentResources.length)throw new KnowledgeError('POSITIVE_SMOKE_FAILED');
        for(const ref of retrieval.documentResources){
          documentScope(store,ref);
          const d=docs.find(x=>x.providerDocumentName===ref);
          if(!d||c.expectedDocumentVersionIds?.length&&!c.expectedDocumentVersionIds.includes(d.documentVersionId))throw new KnowledgeError('UNAUTHORIZED_CITATION');
        }
        if(c.expectedDocumentVersionIds?.some(expected=>!retrieval.documentResources.some(r=>docs.some(d=>d.documentVersionId===expected&&d.providerDocumentName===r))))throw new KnowledgeError('MISSING_EXPECTED_SOURCE');
      }
      result.push({mode:c.mode,citations:retrieval.documentResources});
    }
    for(const d of docs)await this.db.changeDocument(agentId,versionId,d.documentId,d.documentVersionId,{status:'verified'});
    await this.db.markVersion(agentId,versionId,'verified',digest);
    return {digest,results:result};
  }
  async publish(agentId:string,versionId:string,expectedCurrentId:string|null):Promise<void> {
    const v=await this.version(agentId,versionId);
    if(v.state!=='verified'||!v.contentDigestSha256)throw new KnowledgeError('VERSION_NOT_VERIFIED');
    const fresh=await this.verifiedDocs(agentId,versionId);
    if(fresh.digest!==v.contentDigestSha256)throw new KnowledgeError('DIGEST_CHANGED');
    const approvedBy=[...new Set(fresh.docs.map(d=>d.approvalReference!))].sort().join(',');
    const committed=await this.db.publishCAS(agentId,versionId,expectedCurrentId,{
      agentId,knowledgeVersionId:versionId,provider:'gemini_file_search',storeResourceName:fresh.store,state:'published',
      contentDigestSha256:fresh.digest,approvalReference:approvedBy,publishedAt:new Date().toISOString()
    });
    if(!committed)throw new KnowledgeError('PUBLICATION_CONFLICT');
    // Previous sessions remain pinned; old store is not modified/deleted on publication.
  }
  async retire(agentId:string,versionId:string):Promise<void> {
    if((await this.db.currentPublishedVersion(agentId))===versionId)throw new KnowledgeError('CURRENT_VERSION');
    if(await this.db.pinnedActiveSessions(agentId,versionId))throw new KnowledgeError('PINNED_SESSIONS');
    if(!await this.db.retireIfUnpinned(agentId,versionId))throw new KnowledgeError('RETIRE_CONFLICT');
    // Provider deletion is a separate privileged, auditable cleanup after retention review.
  }
  async revoke(agentId:string,versionId:string,reason:string):Promise<void> {
    if(!reason.trim())throw new KnowledgeError('REVOCATION_REASON_REQUIRED');
    await this.db.revoke(agentId,versionId,reason);
    // Integration owner must enforce server-side runtime binding lookup against revocation.
  }
  async resolveEvidence(agentId:string,versionId:string,providerId:string,locator:string|null,excerpt:string|null) {
    const v=await this.version(agentId,versionId);
    if(v.state!=='published')throw new KnowledgeError('VERSION_NOT_PUBLISHED');
    const store=storeScope(v.storeResourceName??'');documentScope(store,providerId);
    const docs=await this.db.listDocuments(agentId,versionId);
    const d=docs.find(x=>x.providerDocumentName===providerId);
    if(!d||!d.approvalReference||!['verified','published'].includes(d.status))throw new KnowledgeError('EVIDENCE_NOT_APPROVED');
    return {agentId,knowledgeVersionId:versionId,documentId:d.documentId,documentVersionId:d.documentVersionId,
      providerStoreResourceName:store,providerDocumentResourceName:providerId,sourceSha256:d.sha256,sourceTitle:d.name,
      sourceLocator:locator,evidenceExcerpt:excerpt,approvalReference:d.approvalReference,approvalStatus:'approved' as const,indexStatus:'active' as const};
  }
  async inspect(agentId:string,versionId:string) {return {version:await this.version(agentId,versionId),documents:await this.db.listDocuments(agentId,versionId)};}
}
