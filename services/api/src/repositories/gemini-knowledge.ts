/**
 * Operator-only PostgreSQL implementation of P3 KnowledgeRepository.
 * Import from the ingestion CLI, never from a customer/API handler.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import type { KnowledgeRepository,DocumentRecord,VersionRecord,DocumentStatus,VersionStatus } from "../knowledge/publisher.js";

const states:ReadonlySet<string>=new Set([
"awaiting_approval","approved","indexing","indexed","verified","published","failed","retired","revoked",
]);
function mapVersion(x:any):VersionRecord {
  return {agentId:x.agent_id,id:x.id,state:x.state,storeResourceName:x.store_resource_name,
    contentDigestSha256:x.content_digest_sha256,approvalReference:x.approval_reference,
    publishedAt:x.published_at?new Date(x.published_at).toISOString():null};
}
function mapDoc(x:any):DocumentRecord {
  return {agentId:x.agent_id,knowledgeVersionId:x.knowledge_version_id,
    documentId:x.document_id,documentVersionId:x.document_version_id,
    name:x.source_name,sha256:x.source_sha256,mime:x.source_mime,
    originalPath:x.original_storage_ref,required:x.required,status:x.document_status,
    approvalReference:x.approval_reference,operationName:x.operation_name,
    providerDocumentName:x.provider_document_resource_name};
}
function valid(uuid:string,field:string):string{return requireUuid(uuid,field);}

export class PgGeminiKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db:PersistenceDatabase){}
  async getVersion(agentId:string,id:string):Promise<VersionRecord|null>{
    valid(id,"knowledgeVersionId");
    return this.db.withAgent(agentId,async c=>{
      const r=await c.query("SELECT * FROM gemini_knowledge_versions WHERE agent_id=$1 AND id=$2",[agentId,id]);
      return r.rows[0]?mapVersion(r.rows[0]):null;
    });
  }
  async createDraft(agentId:string,id:string):Promise<void>{
    valid(id,"knowledgeVersionId");
    await this.db.withAgent(agentId,async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[agentId]);
      const r=await c.query(
        `INSERT INTO gemini_knowledge_versions(agent_id,id,revision)
         VALUES($1,$2,(SELECT coalesce(max(revision),0)+1 FROM gemini_knowledge_versions WHERE agent_id=$1))
         ON CONFLICT(agent_id,id) DO NOTHING`,[agentId,id]);
      const v=await c.query("SELECT state FROM gemini_knowledge_versions WHERE agent_id=$1 AND id=$2",[agentId,id]);
      if(v.rows[0]?.state!=="draft")throw new PersistenceError("CONFLICT","Knowledge version not draft");
    });
  }
  async attachStore(agentId:string,id:string,store:string):Promise<void>{
    valid(id,"knowledgeVersionId");
    await this.db.withAgent(agentId,async c=>{
      const r=await c.query(
        "UPDATE gemini_knowledge_versions SET store_resource_name=$3 WHERE agent_id=$1 AND id=$2 AND state IN ('draft','indexing') AND (store_resource_name IS NULL OR store_resource_name=$3) RETURNING id",
        [agentId,id,store]);
      if(!r.rowCount)throw new PersistenceError("CONFLICT","Store binding already published or changed");
    });
  }
  async listDocuments(agentId:string,versionId:string):Promise<DocumentRecord[]>{
    valid(versionId,"knowledgeVersionId");
    return this.db.withAgent(agentId,async c=>{
      const r=await c.query(
        `SELECT d.*,r.source_sha256,r.original_storage_ref,r.approval_reference
         FROM gemini_knowledge_documents d JOIN gemini_source_revisions r
         ON r.agent_id=d.agent_id AND r.id=d.document_version_id
         WHERE d.agent_id=$1 AND d.knowledge_version_id=$2 ORDER BY d.document_version_id`,
        [agentId,versionId]);
      return r.rows.map(mapDoc);
    });
  }
  async findByHash(agentId:string,versionId:string,sha256:string):Promise<DocumentRecord|null>{
    const rows=await this.listDocuments(agentId,versionId);
    return rows.find(r=>r.sha256===sha256)??null;
  }
  async saveDocument(d:DocumentRecord):Promise<void>{
    valid(d.agentId,"agentId");valid(d.knowledgeVersionId,"knowledgeVersionId");
    valid(d.documentId,"documentId");valid(d.documentVersionId,"documentVersionId");
    if(!/^[a-f0-9]{64}$/.test(d.sha256)||!d.originalPath.startsWith("/")||!d.name)
      throw new PersistenceError("INVALID_INPUT","Source metadata invalid");
    const isText=["text/plain","text/markdown"].includes(d.mime);
    let normalizedDigest:string|null=null;
    if(isText){
      const bytes=await readFile(d.originalPath);
      if(createHash("sha256").update(bytes).digest("hex")!==d.sha256)
        throw new PersistenceError("CONFLICT","Original bytes differ from approved intake");
      const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
      if(!text.trim())throw new PersistenceError("INVALID_INPUT","Empty normalized source");
      normalizedDigest=createHash("sha256").update(text,"utf8").digest("hex");
    }
    await this.db.withAgent(d.agentId,async c=>{
      await c.query(
        `INSERT INTO gemini_source_documents(agent_id,id,source_key,title)
         VALUES($1,$2,$3,$4)`,
        [d.agentId,d.documentId,d.documentId,d.name],
      );
      await c.query(
        `INSERT INTO gemini_source_revisions(agent_id,id,document_id,revision,source_sha256,
           original_storage_ref,normalized_text_ref,normalized_text_sha256)
         VALUES($1,$2,$3,1,$4,$5,$6,$7)`,
        [d.agentId,d.documentVersionId,d.documentId,d.sha256,d.originalPath,d.originalPath,normalizedDigest],
      );
      await c.query(
        `INSERT INTO gemini_knowledge_documents(agent_id,knowledge_version_id,document_id,document_version_id,
           document_status,source_name,source_mime,required)
         VALUES($1,$2,$3,$4,'awaiting_approval',$5,$6,$7)`,
        [d.agentId,d.knowledgeVersionId,d.documentId,d.documentVersionId,d.name,d.mime,d.required],
      );
    });
  }
  async changeDocument(agentId:string,versionId:string,documentId:string,documentVersionId:string,patch:Partial<DocumentRecord>):Promise<void>{
    for(const id of [versionId,documentId,documentVersionId])valid(id,"document identity");
    const keys=Object.keys(patch);
    if(!keys.length||keys.some(k=>!["status","approvalReference","operationName","providerDocumentName"].includes(k)))
      throw new PersistenceError("INVALID_INPUT","Invalid document state update");
    if(patch.status && !states.has(patch.status))throw new PersistenceError("INVALID_INPUT","Invalid document status");
    await this.db.withAgent(agentId,async c=>{
      const state=patch.status;
      const index=state==="indexed"||state==="verified"||state==="published"?"active":
        state==="indexing"?"indexing":state==="revoked"?"revoked":null;
      const r=await c.query(
        `UPDATE gemini_knowledge_documents SET
         document_status=coalesce($5,document_status),
         operation_name=coalesce($6,operation_name),
         provider_document_resource_name=coalesce($7,provider_document_resource_name),
         index_status=coalesce($8,index_status),
         indexed_at=CASE WHEN $8='active' THEN coalesce(indexed_at,clock_timestamp()) ELSE indexed_at END
         WHERE agent_id=$1 AND knowledge_version_id=$2 AND document_id=$3 AND document_version_id=$4
         RETURNING id`,
        [agentId,versionId,documentId,documentVersionId,state??null,patch.operationName??null,
         patch.providerDocumentName??null,index],
      );
      if(!r.rowCount)throw new PersistenceError("NOT_FOUND","Document version not found");
    });
  }
  /** Approval is a human/operator-written source revision; never self-approve. */
  async requireApproval(agentId:string,versionId:string,documentId:string,documentVersionId:string):Promise<string>{
    return this.db.withAgent(agentId,async c=>{
      const r=await c.query<{approval_reference:string}>(
        `SELECT r.approval_reference FROM gemini_source_revisions r
         JOIN gemini_knowledge_documents d ON d.agent_id=r.agent_id AND d.document_version_id=r.id
         WHERE r.agent_id=$1 AND d.knowledge_version_id=$2 AND d.document_id=$3 AND r.id=$4
           AND r.approval_status='approved' AND r.approved_at IS NOT NULL`,
        [agentId,versionId,documentId,documentVersionId],
      );
      if(!r.rows[0]?.approval_reference)throw new PersistenceError("CONFLICT","Human approval required");
      return r.rows[0].approval_reference;
    });
  }
  async markVersion(agentId:string,id:string,state:VersionStatus,digest?:string):Promise<void>{
    valid(id,"knowledgeVersionId");
    if(!["draft","indexing","verified"].includes(state))throw new PersistenceError("INVALID_INPUT","Invalid preparation state");
    await this.db.withAgent(agentId,async c=>{
      const r=await c.query(
        `UPDATE gemini_knowledge_versions SET state=$3,content_digest_sha256=coalesce($4,content_digest_sha256)
         WHERE agent_id=$1 AND id=$2 AND state IN ('draft','indexing','verified') RETURNING id`,
        [agentId,id,state,digest??null],
      );
      if(!r.rowCount)throw new PersistenceError("CONFLICT","Version not editable");
    });
  }
  async currentPublishedVersion(agentId:string):Promise<string|null>{
    return this.db.withAgent(agentId,async c=>{
      const r=await c.query<{id:string}>(
        "SELECT id FROM gemini_knowledge_versions WHERE agent_id=$1 AND state='published'",[agentId]);
      return r.rows[0]?.id??null;
    });
  }
  async pinnedActiveSessions(agentId:string,id:string):Promise<number>{
    valid(id,"knowledgeVersionId");
    return this.db.withAgent(agentId,async c=>{
      const r=await c.query<{n:string}>(
        `SELECT count(*)::text AS n FROM ai_conversation_sessions
         WHERE agent_id=$1 AND knowledge_version_id=$2 AND status='active' AND expires_at>clock_timestamp()`,
        [agentId,id]);
      return Number(r.rows[0]?.n??0);
    });
  }
  async publishCAS(agentId:string,id:string,expected:string|null,binding:{
    agentId:string;knowledgeVersionId:string;provider:"gemini_file_search";storeResourceName:string;
    state:"published";contentDigestSha256:string;approvalReference:string|null;publishedAt:string;
  }):Promise<boolean>{
    valid(id,"knowledgeVersionId");if(expected)valid(expected,"expectedCurrentId");
    if(!binding.approvalReference||binding.agentId!==agentId||binding.knowledgeVersionId!==id)
      throw new PersistenceError("INVALID_INPUT","Invalid approved publication binding");
    return this.db.withAgent(agentId,async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))",[agentId]);
      const published=await c.query<{id:string}>("SELECT id FROM gemini_knowledge_versions WHERE agent_id=$1 AND state='published' FOR UPDATE",[agentId]);
      if((published.rows[0]?.id??null)!==expected)return false;
      const draft=await c.query<{state:string}>(
        "SELECT state FROM gemini_knowledge_versions WHERE agent_id=$1 AND id=$2 FOR UPDATE",[agentId,id]);
      if(draft.rows[0]?.state!=="verified")return false;
      const agent=await c.query<{active_version_id:string}>(
        "SELECT active_version_id FROM agents WHERE id=$1 AND status='active' FOR UPDATE",[agentId]);
      if(!agent.rows[0]?.active_version_id)return false;
      const source=await c.query<any>(
        "SELECT * FROM agent_versions WHERE agent_id=$1 AND id=$2 AND provider='gemini' AND publication_state='published'",
        [agentId,agent.rows[0].active_version_id]);
      if(!source.rows[0])return false;
      if(expected)await c.query("UPDATE gemini_knowledge_versions SET state='retired' WHERE agent_id=$1 AND id=$2 AND state='published'",[agentId,expected]);
      const switched=await c.query(
        `UPDATE gemini_knowledge_versions SET state='published',content_digest_sha256=$3,
         approval_reference=$4,published_at=$5 WHERE agent_id=$1 AND id=$2 AND state='verified'
         AND store_resource_name=$6 RETURNING id`,
        [agentId,id,binding.contentDigestSha256,binding.approvalReference,binding.publishedAt,binding.storeResourceName]);
      if(!switched.rowCount)throw new PersistenceError("CONFLICT","Publication compare-and-swap failed");
      const previous=source.rows[0];
      const number=await c.query<{n:number}>(
        "SELECT coalesce(max(version_number),0)+1 AS n FROM agent_versions WHERE agent_id=$1",[agentId]);
      const created=await c.query<{id:string}>(
        `INSERT INTO agent_versions(agent_id,version_number,foundry_project_endpoint,foundry_agent_name,
         foundry_agent_version,knowledge_binding_ref,persona_config,provider,model_id,persona_version,
         system_instructions,allowed_node_tools,knowledge_version_id,knowledge_status,
         intent_catalog_version_id,offering_catalog_version_id)
         VALUES($1,$2,NULL,NULL,NULL,NULL,$3,'gemini',$4,$5,$6,$7,$8,'bound',$9,$10)
         RETURNING id`,
        [agentId,number.rows[0].n,previous.persona_config,previous.model_id,previous.persona_version,
         previous.system_instructions,previous.allowed_node_tools,id,
         previous.intent_catalog_version_id,previous.offering_catalog_version_id],
      );
      const newId=created.rows[0]?.id;
      if(!newId)throw new PersistenceError("DATABASE_ERROR","New Gemini version missing");
      await c.query("UPDATE agent_versions SET publication_state='ready' WHERE agent_id=$1 AND id=$2",[agentId,newId]);
      await c.query("UPDATE agent_versions SET publication_state='published' WHERE agent_id=$1 AND id=$2",[agentId,newId]);
      await c.query("UPDATE agents SET active_version_id=$2 WHERE id=$1",[agentId,newId]);
      return true;
    });
  }
  async retireIfUnpinned(agentId:string,id:string):Promise<boolean>{
    valid(id,"knowledgeVersionId");
    return this.db.withAgent(agentId,async c=>{
      const r=await c.query(
        `UPDATE gemini_knowledge_versions SET state='retired'
         WHERE agent_id=$1 AND id=$2 AND state IN ('published','verified')
         AND NOT EXISTS(SELECT 1 FROM ai_conversation_sessions s
           WHERE s.agent_id=$1 AND s.knowledge_version_id=$2
             AND s.status='active' AND s.expires_at>clock_timestamp()) RETURNING id`,
        [agentId,id]);
      return !!r.rowCount;
    });
  }
  async revoke(agentId:string,id:string,reason:string):Promise<void>{
    valid(id,"knowledgeVersionId");
    if(!reason.trim()||reason.length>1000)throw new PersistenceError("INVALID_INPUT","Revocation reason required");
    await this.db.withAgent(agentId,async c=>{
      const r=await c.query(
        "UPDATE gemini_knowledge_versions SET state='revoked' WHERE agent_id=$1 AND id=$2 AND state IN ('published','retired','verified') RETURNING id",
        [agentId,id]);
      if(!r.rowCount)throw new PersistenceError("CONFLICT","Version cannot be revoked");
    });
  }
}

/** No in-memory fallback; operator must use a separate DB owner credential. */
export async function createKnowledgeRepository({operatorToken}:{operatorToken?:string}={}):Promise<KnowledgeRepository>{
  if(!operatorToken || operatorToken.length<32 || operatorToken!==process.env.KNOWLEDGE_OPERATOR_TOKEN ||
     process.env.KNOWLEDGE_OPERATOR_MODE!=="true")
    throw new PersistenceError("NOT_CONFIGURED","Knowledge operator authorization required");
  const db=new PersistenceDatabase(process.env.KNOWLEDGE_DATABASE_URL);
  return new PgGeminiKnowledgeRepository(db);
}
