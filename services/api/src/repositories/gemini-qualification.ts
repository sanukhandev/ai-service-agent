/**
 * Store independent verifier decisions. A candidate is NOT authorization to
 * persist or stream its assistant text; the integration owner must enforce
 * qualification before publication in the shared turn worker.
 *
 * No raw prompts, API keys, session cookies, or customer credentials are logged.
 */
import { PersistenceDatabase, PersistenceError, requireBounded, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "./types.js";

const categories = ["social","clarification","business_factual","catalog_factual","operation_status"] as const;
const decisions = ["supported","unsupported","insufficient_evidence","unauthorized_source","verifier_unavailable"] as const;
const authorities = ["approved_file_search","approved_catalog","verified_operation"] as const;

function requireEnum(value:string, values:readonly string[],field:string) {
  if (!values.includes(value)) throw new PersistenceError("INVALID_INPUT","Invalid "+field);
}
function safeAuditString(value:string,name:string,max:number) {
  const text=requireBounded(value,name,max);
  // Reject common credential shapes rather than laundering them into an audit.
  // Other PII detection/redaction belongs to the integration owner's privacy path.
  if (/(?:bearer\s+\S+|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+)/i.test(text)) {
    throw new PersistenceError("INVALID_INPUT","Secrets must not be stored in verifier audits");
  }
  return text;
}

export class GeminiQualificationRepository {
  constructor(private readonly db:PersistenceDatabase) {}

  /** Verifier input is already policy-evaluated, not a raw model-generated decision.
   * The database independently checks authoritative source ownership/approval.
   */
  async record(scope:TicketScope,sessionId:string,customerMessageId:string,
    decision:{
      readonly status:(typeof decisions)[number];
      readonly category:(typeof categories)[number];
      readonly verifierVersion:string;
      readonly reasonCode:string|null;
      readonly claims: readonly {
        readonly claimId:string;
        readonly claimText:string;
        readonly supported:boolean;
        readonly reason:string|null;
        readonly evidence: readonly {
          readonly authority:(typeof authorities)[number];
          readonly evidenceId:string;
          readonly documentVersionId:string|null;
          readonly knowledgeVersionId:string|null;
        }[];
      }[];
    },
  ) {
    requireUuid(sessionId,"sessionId");
    requireUuid(customerMessageId,"customerMessageId");
    requireEnum(decision.status,decisions,"grounding status");
    requireEnum(decision.category,categories,"category");
    const verifierVersion=safeAuditString(decision.verifierVersion,"verifierVersion",128);
    const reasonCode=decision.reasonCode===null?null:safeAuditString(decision.reasonCode,"reasonCode",200);
    if(!Array.isArray(decision.claims)||decision.claims.length>100)
      throw new PersistenceError("INVALID_INPUT","Invalid material claims");
    if(!["social","clarification"].includes(decision.category) && decision.status==="supported"
      && decision.claims.length===0)
      throw new PersistenceError("CONFLICT","Factual qualification must contain material claims");
    if(decision.claims.some(c=>c.supported && c.evidence.length===0 && decision.category!=="social"
      && decision.category!=="clarification"))
      throw new PersistenceError("CONFLICT","Supported business claim requires authoritative evidence");
    return this.db.withAgent(scope.agentId,async client=>{
      const session=await client.query<{ticket_id:string;status:string;expires_at:Date;knowledge_version_id:string|null}>(
        "SELECT ticket_id,status,expires_at,knowledge_version_id FROM ai_conversation_sessions WHERE agent_id=$1 AND id=$2",
        [scope.agentId,sessionId],
      );
      const s=session.rows[0];
      if(!s) throw new PersistenceError("NOT_FOUND","AI session unavailable");
      await authorizedTicket(client,scope,s.ticket_id,true);
      const locked=await client.query<{status:string;expires_at:Date}>(
        "SELECT status,expires_at FROM ai_conversation_sessions WHERE agent_id=$1 AND id=$2 FOR UPDATE",
        [scope.agentId,sessionId],
      );
      if(locked.rows[0]?.status!=="active" ||
         (await client.query<{valid:boolean}>("SELECT clock_timestamp() < $1::timestamptz AS valid",[locked.rows[0]?.expires_at])).rows[0]?.valid!==true)
        throw new PersistenceError("CONFLICT","Cannot qualify response for expired session");
      const customer=await client.query(
        "SELECT 1 FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND role='customer'",
        [scope.agentId,s.ticket_id,customerMessageId],
      );
      if(!customer.rowCount) throw new PersistenceError("NOT_FOUND","Accepted customer message missing");
      const saved=await client.query<{id:string}>(
        "INSERT INTO gemini_response_qualifications(agent_id,session_id,ticket_id,customer_message_id,category,grounding_status,verifier_version,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [scope.agentId,sessionId,s.ticket_id,customerMessageId,decision.category,
         decision.status,verifierVersion,reasonCode],
      );
      const qualificationId=saved.rows[0]?.id;
      if(!qualificationId) throw new PersistenceError("DATABASE_ERROR","Audit insert failed");
      for(const claim of decision.claims) {
        const claimKey=safeAuditString(claim.claimId,"claimId",128);
        const claimText=safeAuditString(claim.claimText,"claimText",2000);
        const reason=claim.reason===null?null:safeAuditString(claim.reason,"reason",200);
        const row=await client.query<{id:string}>(
          "INSERT INTO gemini_response_claims(agent_id,qualification_id,claim_key,claim_text,supported,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [scope.agentId,qualificationId,claimKey,claimText,claim.supported,reason],
        );
        for(const e of claim.evidence) {
          requireEnum(e.authority,authorities,"evidence authority");
          const reference=safeAuditString(e.evidenceId,"evidenceId",1024);
          const knowledgeVersionId=e.knowledgeVersionId===null?null:requireUuid(e.knowledgeVersionId,"knowledgeVersionId");
          const documentVersionId=e.documentVersionId===null?null:requireUuid(e.documentVersionId,"documentVersionId");
          await client.query(
            "INSERT INTO gemini_response_evidence(agent_id,claim_id,authority,knowledge_version_id,document_version_id,evidence_reference) VALUES($1,$2,$3,$4,$5,$6)",
            [scope.agentId,row.rows[0].id,e.authority,knowledgeVersionId,documentVersionId,reference],
          );
          // 012 DB triggers reject mismatched stores, unapproved catalog,
          // unverified operation outcomes, and cross-session references.
        }
      }
      return {qualificationId,groundingStatus:decision.status,claimCount:decision.claims.length};
    });
  }
  /** Link the accepted assistant reply to its independently supported audit.
   * Integration owner must call only after P4 verification and assistant persistence.
   * An expired session can never attach a new assistant response.
   */
  async attachAssistant(scope:TicketScope,sessionId:string,qualificationId:string,assistantMessageId:string) {
    requireUuid(sessionId,"sessionId");
    requireUuid(qualificationId,"qualificationId");
    requireUuid(assistantMessageId,"assistantMessageId");
    return this.db.withAgent(scope.agentId,async client=>{
      const audit=await client.query<{ticket_id:string}>(
        "SELECT ticket_id FROM gemini_response_qualifications WHERE agent_id=$1 AND id=$2 AND session_id=$3",
        [scope.agentId,qualificationId,sessionId],
      );
      const ticketId=audit.rows[0]?.ticket_id;
      if(!ticketId) throw new PersistenceError("NOT_FOUND","Qualification not found");
      await authorizedTicket(client,scope,ticketId,true);
      const current=await client.query<{id:string}>(
        "SELECT q.id FROM gemini_response_qualifications q JOIN ai_conversation_sessions s ON s.agent_id=q.agent_id AND s.id=q.session_id WHERE q.agent_id=$1 AND q.id=$2 AND q.session_id=$3 AND s.status='active' AND s.expires_at>clock_timestamp() FOR UPDATE OF q",
        [scope.agentId,qualificationId,sessionId],
      );
      if(!current.rows[0]) throw new PersistenceError("CONFLICT","Session expired before assistant publication");
      const attached=await client.query<{id:string}>(
        "UPDATE gemini_response_qualifications SET assistant_message_id=$4 WHERE agent_id=$1 AND id=$2 AND session_id=$3 AND assistant_message_id IS NULL RETURNING id",
        [scope.agentId,qualificationId,sessionId,assistantMessageId],
      );
      if(!attached.rows[0]) throw new PersistenceError("CONFLICT","Assistant qualification already linked");
      return {qualificationId,assistantMessageId};
    });
  }
}
