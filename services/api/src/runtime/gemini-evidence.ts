import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ModelTurnCandidate, ProviderSourceAnnotation, AiSessionState, AgentRuntimeBinding } from "@ai-service-agent/contracts/gemini-v1";
import type { SourceRecord, CatalogRecord, OperationRecord } from "../grounding/index.js";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { GeminiBindingRepository } from "../repositories/gemini.js";
import type { TicketScope } from "../repositories/types.js";

function inside(root:string,target:string):boolean {
  const path=relative(root,target);
  return path!=="" && path!==".." && !path.startsWith(".."+sep) && !isAbsolute(path);
}
function sha(text:string):string{return createHash("sha256").update(text,"utf8").digest("hex");}

/**
 * The original approved source and normalization hash are managed by Node, not
 * inferred from generated citations. On missing identity or private storage,
 * return no trusted documents so the independent verifier fails closed.
 */
export async function resolveGeminiEvidence(
  db:PersistenceDatabase,scope:TicketScope,session:AiSessionState,
  agent:AgentRuntimeBinding,candidate:ModelTurnCandidate,
):Promise<{candidate:ModelTurnCandidate;documents:SourceRecord[];catalogs:CatalogRecord[];operations:OperationRecord[]}> {
  const documents:SourceRecord[]=[];
  const normalizedAnnotations:ProviderSourceAnnotation[]=[];
  const store=agent.knowledge?.storeResourceName;
  const sourceRoot=process.env.GEMINI_APPROVED_TEXT_ROOT;
  if(store && sourceRoot && isAbsolute(sourceRoot) && candidate.sourceAnnotations.length<=16) {
    const bindings=new GeminiBindingRepository(db);
    const root=await realpath(sourceRoot).catch(()=>null);
    if(root) {
      for(const citation of candidate.sourceAnnotations){
        const id=citation.providerResourceName;
        const meta=citation.sourceMetadata;
        // Metadata is returned by Google's retrieval tool, but becomes
        // authoritative only after comparing ALL immutable fields to PostgreSQL.
        let found=meta
          ? await bindings.approvedDocumentFromMetadata(scope,session.sessionId,store,meta).catch(()=>null)
          : null;
        if(meta && !found) {
          normalizedAnnotations.push(citation);continue;
        }
        if(id && found && id!==found.providerDocumentResourceName) {
          normalizedAnnotations.push({...citation,providerResourceName:null});continue;
        }
        if(!found && id && id.startsWith(store+"/documents/") &&
           /^fileSearchStores\/[A-Za-z0-9_-]+\/documents\/[A-Za-z0-9_-]+$/.test(id)) {
          found=await bindings.approvedDocument(scope,session.sessionId,store,id).catch(()=>null);
        }
        if(!found) {normalizedAnnotations.push(citation);continue;}
        // This is the stored Google document identity, verified by PostgreSQL
        // (not fabricated from a title, snippet or model-provided store).
        normalizedAnnotations.push({...citation,providerResourceName:found.providerDocumentResourceName});
        const revision=await db.withAgent(scope.agentId,async client=>{
          const r=await client.query<{normalized_text_ref:string;normalized_text_sha256:string|null}>(
            `SELECT r.normalized_text_ref,r.normalized_text_sha256
             FROM gemini_source_revisions r JOIN gemini_knowledge_documents d
             ON d.agent_id=r.agent_id AND d.document_version_id=r.id
             WHERE r.agent_id=$1 AND r.id=$2 AND d.knowledge_version_id=$3
             AND r.approval_status='approved' AND d.index_status='active'`,
            [scope.agentId,found.documentVersionId,session.knowledgeVersionId],
          );
          return r.rows[0]??null;
        });
        if(!revision?.normalized_text_sha256 || !/^[a-f0-9]{64}$/.test(revision.normalized_text_sha256))continue;
        const path=resolve(revision.normalized_text_ref);
        if(!inside(root,path))continue;
        const actual=await realpath(path).catch(()=>null);
        if(!actual || !inside(root,actual))continue;
        const size=await stat(actual).catch(()=>null);
        if(!size?.isFile() || size.size<=0 || size.size>200_000)continue;
        const text=await readFile(actual,"utf8").catch(()=>null);
        if(!text || sha(text)!==revision.normalized_text_sha256)continue;
        documents.push({...found,verifiedText:text,verifiedTextSha256:revision.normalized_text_sha256});
      }
    }
  }
  // Existing test catalogs are explicitly unapproved. Catalog facts become
  // usable only after the independently approved, version-pinned provenance
  // resolver is implemented. Do not promote arbitrary model tool outputs.
  // P4 must see the authoritative post-resolution document resource name.
  // If private source bytes are unavailable, it still rejects unsupported
  // claims because no verified SourceRecord exists.
  return {candidate:{...candidate,sourceAnnotations:normalizedAnnotations.length===candidate.sourceAnnotations.length
    ? normalizedAnnotations:candidate.sourceAnnotations},documents,catalogs:[],operations:[]};
}
