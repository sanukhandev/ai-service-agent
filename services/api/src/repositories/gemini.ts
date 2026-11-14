/**
 * Gemini P2 persistence only. The frozen G0 interfaces remain defined in
 * packages/contracts/gemini-v1.ts; returned objects structurally conform to
 * AiSessionState and AgentRuntimeBinding without a second contract definition.
 *
 * All agent IDs and TicketScope values originate from trusted Node auth.
 * The caller must not construct TicketScope from Gemini or browser arguments.
 */
import type { PoolClient } from "pg";
import type { NodeBusinessToolName } from "@ai-service-agent/contracts/gemini-v1";
import { PersistenceDatabase, PersistenceError, requireBounded, requireUuid } from "../database/pool.js";
import { appendEventTx } from "./events.js";
import { authorizedTicket, assertAgentActive, asIso, ownerParameters, type TicketScope } from "./types.js";

interface AiSessionRow {
  id: string; agent_id: string; ticket_id: string; agent_version_id: string;
  knowledge_version_id: string | null; intent_catalog_version_id: string | null;
  offering_catalog_version_id: string | null; model_id: string;
  status: "active" | "expired" | "closed"; created_at: Date;
  last_accepted_customer_message_at: Date; expires_at: Date;
  continuation_opaque_ref: string | null; pending_tool_state_ref: string | null;
}
interface CustomerMessageRow {
  id: string; message_sequence: string; created_at: Date; content: string;
  role: "customer" | "assistant"; request_id: string | null;
}
function mapSession(s: AiSessionRow) {
  return {
    sessionId: s.id, agentId: s.agent_id, ticketId: s.ticket_id,
    agentVersionId: s.agent_version_id, knowledgeVersionId: s.knowledge_version_id,
    intentCatalogVersionId: s.intent_catalog_version_id,
    offeringCatalogVersionId: s.offering_catalog_version_id,
    status: s.status, createdAt: asIso(s.created_at) as string,
    lastAcceptedCustomerMessageAt: asIso(s.last_accepted_customer_message_at) as string,
    expiresAt: asIso(s.expires_at) as string,
    providerContinuation: s.continuation_opaque_ref === null && s.pending_tool_state_ref === null
      ? null : {
        provider: "gemini" as const, modelId: s.model_id,
        opaqueRef: s.continuation_opaque_ref, pendingToolStateRef: s.pending_tool_state_ref,
      },
  };
}
function mapMessage(m: CustomerMessageRow) {
  return { id: m.id, sequence: String(m.message_sequence), text: m.content,
    role: m.role, requestId: m.request_id, createdAt: asIso(m.created_at) as string };
}

async function lockedSession(client: PoolClient, scope: TicketScope, sessionId: string) {
  requireUuid(sessionId, "sessionId");
  // Read the ticket pointer without trusting it. Authorization is independently
  // checked under the same agent-scoped transaction and ticket row lock.
  const pointer = await client.query<{ ticket_id: string }>(
    "SELECT ticket_id FROM ai_conversation_sessions WHERE agent_id=$1 AND id=$2",
    [scope.agentId, sessionId],
  );
  if (!pointer.rows[0]) throw new PersistenceError("NOT_FOUND", "AI session not found");
  await authorizedTicket(client, scope, pointer.rows[0].ticket_id, true);
  const locked = await client.query<AiSessionRow>(
    "SELECT * FROM ai_conversation_sessions WHERE agent_id=$1 AND id=$2 FOR UPDATE",
    [scope.agentId, sessionId],
  );
  const row = locked.rows[0];
  if (!row || row.ticket_id !== pointer.rows[0].ticket_id) {
    throw new PersistenceError("NOT_FOUND", "AI session not found");
  }
  return row;
}
async function clock(client: PoolClient): Promise<Date> {
  const result = await client.query<{ at: Date }>("SELECT clock_timestamp() AS at");
  const at = result.rows[0]?.at;
  if (!at) throw new PersistenceError("DATABASE_ERROR", "Database clock unavailable");
  return at;
}
async function expireIfNeeded(client: PoolClient, row: AiSessionRow, at: Date): Promise<boolean> {
  if (row.status !== "active") return true;
  if (at.getTime() < row.expires_at.getTime()) return false;
  await client.query(
    "UPDATE ai_conversation_sessions SET status='expired', continuation_opaque_ref=NULL, pending_tool_state_ref=NULL, updated_at=$3 WHERE agent_id=$1 AND id=$2 AND status='active'",
    [row.agent_id, row.id, at],
  );
  return true;
}

/** One ticket per AI session; expiry leaves the historical ticket intact. */
export class GeminiSessionRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  /** Atomic new ticket+session. Never attach a new AI session to an old ticket. */
  async startNew(scope: TicketScope, subject = "New enquiry") {
    requireBounded(subject, "subject", 200);
    return this.db.withAgent(scope.agentId, async client => {
      if (scope.owner.kind === "internal") {
        throw new PersistenceError("INVALID_INPUT", "Customer identity required");
      }
      await assertAgentActive(client, scope.agentId);
      const [tokenHash, accountId] = ownerParameters(scope);
      let guestId: string | null = null;
      if (scope.owner.kind === "guest") {
        const guest = await client.query<{id:string}>(
          "SELECT id FROM guest_sessions WHERE agent_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp()",
          [scope.agentId, tokenHash],
        );
        guestId = guest.rows[0]?.id ?? null;
        if (!guestId) throw new PersistenceError("NOT_FOUND", "Guest identity expired");
      } else {
        const account = await client.query(
          "SELECT 1 FROM agent_accounts WHERE agent_id=$1 AND id=$2 AND email_verified_at IS NOT NULL",
          [scope.agentId, accountId],
        );
        if (!account.rowCount) throw new PersistenceError("NOT_FOUND", "Verified account required");
      }
      const bound = await client.query<{
        version_id:string;model_id:string;knowledge_version_id:string|null;
        intent_catalog_id:string|null;offering_catalog_id:string|null;
      }>([
        "SELECT v.id AS version_id,v.model_id,v.knowledge_version_id,",
        "ic.id AS intent_catalog_id,oc.id AS offering_catalog_id",
        "FROM agents a JOIN agent_versions v ON v.agent_id=a.id AND v.id=a.active_version_id",
        "LEFT JOIN LATERAL (SELECT id FROM intent_catalog_versions",
        " WHERE agent_id=a.id AND status='published' LIMIT 1) ic ON true",
        "LEFT JOIN LATERAL (SELECT id FROM offering_catalog_versions",
        " WHERE agent_id=a.id AND status='published' LIMIT 1) oc ON true",
        "WHERE a.id=$1 AND a.status='active' AND v.provider='gemini'",
        "AND v.publication_state='published' AND v.published_at IS NOT NULL",
      ].join(" "), [scope.agentId]);
      const b=bound.rows[0];
      if(!b || !b.intent_catalog_id || !b.offering_catalog_id) {
        throw new PersistenceError("NOT_CONFIGURED", "Gemini agent and published catalogs required");
      }
      if(b.knowledge_version_id) {
        const approved=await client.query(
          "SELECT 1 FROM gemini_knowledge_versions WHERE agent_id=$1 AND id=$2 AND state='published'",
          [scope.agentId,b.knowledge_version_id],
        );
        if(!approved.rowCount) throw new PersistenceError("NOT_CONFIGURED", "Approved knowledge unavailable");
      }
      const ticket=await client.query<{id:string}>(
        "INSERT INTO tickets(agent_id,agent_version_id,guest_session_id,account_id,subject,intent_catalog_version_id,offering_catalog_version_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [scope.agentId,b.version_id,guestId,accountId,subject,b.intent_catalog_id,b.offering_catalog_id],
      );
      const ticketId=ticket.rows[0]?.id;
      if(!ticketId) throw new PersistenceError("DATABASE_ERROR", "Ticket insert failed");
      const ts=await clock(client);
      const session=await client.query<AiSessionRow>(
        "INSERT INTO ai_conversation_sessions(agent_id,ticket_id,agent_version_id,knowledge_version_id,intent_catalog_version_id,offering_catalog_version_id,model_id,created_at,last_accepted_customer_message_at,expires_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$8::timestamptz,$8::timestamptz + interval '60 minutes',$8::timestamptz) RETURNING *",
        [scope.agentId,ticketId,b.version_id,b.knowledge_version_id,b.intent_catalog_id,b.offering_catalog_id,b.model_id,ts],
      );
      await appendEventTx(client,scope.agentId,ticketId,"ticket.created",{ticketId,subject});
      return mapSession(session.rows[0]);
    });
  }

  /** Admission uses database time AFTER locking the ticket and session.
   * Duplicate request IDs do not slide the deadline. Exactly 60 minutes expires.
   */
  async admitCustomerMessage(scope: TicketScope, sessionId: string, requestId: string, text: string) {
    requireUuid(requestId,"requestId");
    const cleaned=requireBounded(text,"message",12_000);
    return this.db.withAgent(scope.agentId,async client=>{
      const row=await lockedSession(client,scope,sessionId);
      const at=await clock(client);
      if(await expireIfNeeded(client,row,at)) {
        return {kind:"expired" as const,session:mapSession({...row,status:row.status==="active"?"expired":row.status,continuation_opaque_ref:null,pending_tool_state_ref:null}),message:null};
      }
      const prior=await client.query<CustomerMessageRow>(
        "SELECT id,message_sequence,created_at,content,role,request_id FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND role='customer' AND request_id=$3",
        [scope.agentId,row.ticket_id,requestId],
      );
      if(prior.rows[0]){
        if(prior.rows[0].content!==cleaned) throw new PersistenceError("CONFLICT","Request ID reused with different message");
        return {kind:"duplicate" as const,session:mapSession(row),message:mapMessage(prior.rows[0])};
      }
      await assertAgentActive(client,scope.agentId);
      const next=await client.query<{last_message_sequence:string}>(
        "UPDATE tickets SET last_message_sequence=last_message_sequence+1,updated_at=$3 WHERE agent_id=$1 AND id=$2 AND status<>'closed' RETURNING last_message_sequence",
        [scope.agentId,row.ticket_id,at],
      );
      const sequence=next.rows[0]?.last_message_sequence;
      if(!sequence) throw new PersistenceError("CONFLICT","Ticket is closed");
      const inserted=await client.query<CustomerMessageRow>(
        "INSERT INTO ticket_messages(agent_id,ticket_id,role,content,request_id,message_sequence) VALUES($1,$2,'customer',$3,$4,$5) RETURNING id,message_sequence,created_at,content,role,request_id",
        [scope.agentId,row.ticket_id,cleaned,requestId,sequence],
      );
      await appendEventTx(client,scope.agentId,row.ticket_id,"message.accepted",{
        messageId:inserted.rows[0].id,requestId,sequence:String(sequence),
      });
      const updated=await client.query<AiSessionRow>(
        "UPDATE ai_conversation_sessions SET last_accepted_customer_message_at=$3::timestamptz,expires_at=$3::timestamptz+interval '60 minutes',updated_at=$3::timestamptz WHERE agent_id=$1 AND id=$2 AND status='active' RETURNING *",
        [scope.agentId,sessionId,at],
      );
      if(!updated.rows[0]) throw new PersistenceError("CONFLICT","Session transitioned during message acceptance");
      return {kind:"accepted" as const,session:mapSession(updated.rows[0]),message:mapMessage(inserted.rows[0])};
    });
  }

  /** Authorize ticket ownership before finding its sole AI session. Expiry is evaluated by recover(). */
  async forTicket(scope: TicketScope, ticketId: string) {
    requireUuid(ticketId, "ticketId");
    const id = await this.db.withAgent(scope.agentId, async client => {
      await authorizedTicket(client, scope, ticketId);
      const found = await client.query<{id:string}>(
        "SELECT id FROM ai_conversation_sessions WHERE agent_id=$1 AND ticket_id=$2",
        [scope.agentId,ticketId],
      );
      return found.rows[0]?.id ?? null;
    });
    return id ? this.recover(scope,id) : null;
  }

  /**
   * Authoritative bounded model history; unlike browser pagination this reads
   * the latest messages at or BEFORE the claimed customer message.
   * Future accepted turns are intentionally excluded. Oldest-first result
   * includes at most 16 preceding messages and the current message.
   */
  async forModelTurn(scope:TicketScope,ticketId:string,customerMessageId:string){
    requireUuid(ticketId,"ticketId");requireUuid(customerMessageId,"customerMessageId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const found=await client.query<{id:string}>(
        "SELECT id FROM ai_conversation_sessions WHERE agent_id=$1 AND ticket_id=$2",
        [scope.agentId,ticketId]);
      if(!found.rows[0])return null;
      const row=await lockedSession(client,scope,found.rows[0].id);
      const at=await clock(client);
      if(await expireIfNeeded(client,row,at))return {
        active:false,session:mapSession({...row,status:"expired" as const,
          continuation_opaque_ref:null,pending_tool_state_ref:null}),
        messages:[],olderCustomerMessages:[],
      };
      const current=await client.query<{message_sequence:string}>(
        "SELECT message_sequence FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND role='customer'",
        [scope.agentId,ticketId,customerMessageId]);
      if(!current.rows[0])throw new PersistenceError("NOT_FOUND","Accepted customer message unavailable");
      const latest=await client.query<CustomerMessageRow>(
        `SELECT id,message_sequence,created_at,content,role,request_id
         FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2
           AND message_sequence<=$3::bigint
         ORDER BY message_sequence DESC LIMIT 17`,
        [scope.agentId,ticketId,current.rows[0].message_sequence]);
      const chronological=latest.rows.reverse();
      if(!chronological.some(m=>m.id===customerMessageId))
        throw new PersistenceError("CONFLICT","Current turn missing from bounded history");
      // These are unverified customer excerpts, not catalog or RAG evidence.
      const older=await client.query<Pick<CustomerMessageRow,"id"|"message_sequence"|"content">>(
        `SELECT id,message_sequence,content FROM ticket_messages
         WHERE agent_id=$1 AND ticket_id=$2 AND role='customer'
           AND message_sequence<$3::bigint
         ORDER BY message_sequence DESC LIMIT 24`,
        [scope.agentId,ticketId,chronological[0].message_sequence]);
      return {active:true,session:mapSession(row),
        messages:chronological.map(mapMessage),
        olderCustomerMessages:older.rows.reverse().map(m=>({
          sequence:String(m.message_sequence),text:m.content,
        }))};
    });
  }

  /** Browser refresh, Redis loss and model cursor recovery all use this path. */
  async recover(scope: TicketScope, sessionId: string, afterSequence = "0", limit = 500) {
    if(!/^(0|[1-9][0-9]{0,18})$/.test(afterSequence) || !Number.isSafeInteger(limit)
       || limit<1 || limit>1000) throw new PersistenceError("INVALID_INPUT","Invalid history page");
    return this.db.withAgent(scope.agentId,async client=>{
      const row=await lockedSession(client,scope,sessionId);
      const at=await clock(client);
      const expired=await expireIfNeeded(client,row,at);
      if(expired) return {active:false,session:mapSession({...row,status:row.status==="active"?"expired":row.status,continuation_opaque_ref:null,pending_tool_state_ref:null}),messages:[]};
      const messages=await client.query<CustomerMessageRow>(
        "SELECT id,message_sequence,created_at,content,role,request_id FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND message_sequence>$3::bigint ORDER BY message_sequence ASC LIMIT $4",
        [scope.agentId,row.ticket_id,afterSequence,limit],
      );
      // A ticket is never reused across AI sessions; never read old ticket facts
      // or cross-session summaries here, even when the same guest is authenticated.
      return {active:true,session:mapSession(row),messages:messages.rows.map(mapMessage)};
    });
  }

  /** Provider cursor is opaque, compared-and-swapped, and does NOT extend TTL. */
  async advanceContinuation(scope:TicketScope,sessionId:string,
    expectedOpaqueRef:string|null,newOpaqueRef:string|null,pendingToolStateRef:string|null) {
    for(const [name,v] of [["expectedOpaqueRef",expectedOpaqueRef],
      ["newOpaqueRef",newOpaqueRef],["pendingToolStateRef",pendingToolStateRef]] as const) {
      if(v!==null) requireBounded(v,name,2048);
    }
    return this.db.withAgent(scope.agentId,async client=>{
      const row=await lockedSession(client,scope,sessionId);
      const at=await clock(client);
      if(await expireIfNeeded(client,row,at)) throw new PersistenceError("CONFLICT","AI session expired");
      const updated=await client.query<AiSessionRow>(
        "UPDATE ai_conversation_sessions SET continuation_opaque_ref=$3,pending_tool_state_ref=$4,updated_at=$5 WHERE agent_id=$1 AND id=$2 AND continuation_opaque_ref IS NOT DISTINCT FROM $6 RETURNING *",
        [scope.agentId,sessionId,newOpaqueRef,pendingToolStateRef,at,expectedOpaqueRef],
      );
      if(!updated.rows[0]) throw new PersistenceError("CONFLICT","Provider continuation changed");
      return mapSession(updated.rows[0]);
    });
  }

  async close(scope:TicketScope,sessionId:string) {
    return this.db.withAgent(scope.agentId,async client=>{
      const row=await lockedSession(client,scope,sessionId);
      const at=await clock(client);
      const updated=await client.query<AiSessionRow>(
        "UPDATE ai_conversation_sessions SET status=CASE WHEN status='active' AND expires_at<=$3 THEN 'expired' WHEN status='active' THEN 'closed' ELSE status END,continuation_opaque_ref=NULL,pending_tool_state_ref=NULL,updated_at=$3 WHERE agent_id=$1 AND id=$2 RETURNING *",
        [scope.agentId,sessionId,at],
      );
      return mapSession(updated.rows[0] ?? row);
    });
  }

  /** Maintenance only; no Redis dependency. Returns count of expired rows. */
  async expireIdle(agentId:string,batchSize=100):Promise<number> {
    requireUuid(agentId,"agentId");
    if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1000)
      throw new PersistenceError("INVALID_INPUT","Invalid batchSize");
    return this.db.withAgent(agentId,async client=>{
      const result=await client.query(
        "WITH due AS (SELECT id FROM ai_conversation_sessions WHERE agent_id=$1 AND status='active' AND expires_at<=clock_timestamp() ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE ai_conversation_sessions s SET status='expired',continuation_opaque_ref=NULL,pending_tool_state_ref=NULL,updated_at=clock_timestamp() FROM due WHERE s.id=due.id AND s.agent_id=$1 RETURNING s.id",
        [agentId,batchSize],
      );
      return result.rowCount ?? 0;
    });
  }
}

/** Resolves the exact server-pinned model/store and approved document evidence. */
export class GeminiBindingRepository {
  constructor(private readonly db:PersistenceDatabase) {}

  async pinned(agentId:string,versionId:string) {
    requireUuid(versionId,"versionId");
    return this.db.withAgent(agentId,async client=>{
      const result=await client.query<{
        id:string;model_id:string;persona_version:string;system_instructions:string;
        allowed_node_tools:string[];knowledge_version_id:string|null;
        store_resource_name:string|null;state:string|null;content_digest_sha256:string|null;
        approval_reference:string|null;published_at:Date|null;
        intent_catalog_version_id:string|null;offering_catalog_version_id:string|null;
      }>([
        "SELECT v.id,v.model_id,v.persona_version,v.system_instructions,v.allowed_node_tools,",
        "v.knowledge_version_id,k.store_resource_name,k.state,k.content_digest_sha256,k.approval_reference,k.published_at,",
        "v.intent_catalog_version_id,v.offering_catalog_version_id",
        "FROM agent_versions v LEFT JOIN gemini_knowledge_versions k",
        "ON k.agent_id=v.agent_id AND k.id=v.knowledge_version_id",
        "WHERE v.agent_id=$1 AND v.id=$2 AND v.provider='gemini'",
        "AND v.publication_state='published' AND v.published_at IS NOT NULL",
      ].join(" "),[agentId,versionId]);
      const v=result.rows[0];
      if(!v) throw new PersistenceError("NOT_FOUND","Published Gemini binding not found");
      if(v.knowledge_version_id && (v.state!=="published" && v.state!=="retired"))
        throw new PersistenceError("NOT_CONFIGURED","Pinned knowledge was revoked or not published");
      if(v.knowledge_version_id && (!v.store_resource_name || !v.approval_reference || !v.content_digest_sha256))
        throw new PersistenceError("NOT_CONFIGURED","Published knowledge incomplete");
      return {
        agentId,agentVersionId:v.id,provider:"gemini" as const,
        modelId:v.model_id,personaVersion:v.persona_version,
        systemInstructions:v.system_instructions,authorizedToolNames:v.allowed_node_tools as NodeBusinessToolName[],
        knowledge:v.knowledge_version_id ? {
          agentId,knowledgeVersionId:v.knowledge_version_id,
          provider:"gemini_file_search" as const,
          storeResourceName:v.store_resource_name as string,
          state:v.state as "published"|"retired",
          contentDigestSha256:v.content_digest_sha256 as string,
          approvalReference:v.approval_reference,
          publishedAt:asIso(v.published_at),
        }:null,
        intentCatalogVersionId:v.intent_catalog_version_id,
        offeringCatalogVersionId:v.offering_catalog_version_id,
      };
    });
  }


  /** This is the runtime binding for a specific authorized ACTIVE AI session.
   * Session-pinned catalogs take precedence over newly published catalog revisions.
   */
  async forSession(scope:TicketScope,sessionId:string) {
    return this.db.withAgent(scope.agentId,async client=>{
      const s=await lockedSession(client,scope,sessionId);
      if(await expireIfNeeded(client,s,await clock(client)))
        throw new PersistenceError("CONFLICT","AI session expired");
      const query=await client.query<{
        model_id:string;persona_version:string;system_instructions:string;
        allowed_node_tools:string[];state:string|null;
        store_resource_name:string|null;content_digest_sha256:string|null;
        approval_reference:string|null;published_at:Date|null;
      }>([
        "SELECT v.model_id,v.persona_version,v.system_instructions,v.allowed_node_tools,",
        "k.state,k.store_resource_name,k.content_digest_sha256,k.approval_reference,k.published_at",
        "FROM agent_versions v LEFT JOIN gemini_knowledge_versions k",
        "ON k.agent_id=v.agent_id AND k.id=$3",
        "WHERE v.agent_id=$1 AND v.id=$2 AND v.provider='gemini'",
        "AND v.publication_state='published' AND v.published_at IS NOT NULL",
      ].join(" "),[scope.agentId,s.agent_version_id,s.knowledge_version_id]);
      const v=query.rows[0];
      if(!v) throw new PersistenceError("NOT_CONFIGURED","Session-pinned Gemini version missing");
      if(s.knowledge_version_id && (v.state!=="published" && v.state!=="retired"))
        throw new PersistenceError("NOT_CONFIGURED","Session-pinned knowledge revoked");
      if(s.knowledge_version_id && (!v.store_resource_name || !v.content_digest_sha256 || !v.approval_reference))
        throw new PersistenceError("NOT_CONFIGURED","Session-pinned knowledge incomplete");
      return {
        agentId:scope.agentId,agentVersionId:s.agent_version_id,provider:"gemini" as const,
        modelId:v.model_id,personaVersion:v.persona_version,
        systemInstructions:v.system_instructions,authorizedToolNames:v.allowed_node_tools as NodeBusinessToolName[],
        intentCatalogVersionId:s.intent_catalog_version_id,
        offeringCatalogVersionId:s.offering_catalog_version_id,
        knowledge:s.knowledge_version_id ? {
          agentId:scope.agentId,knowledgeVersionId:s.knowledge_version_id,
          provider:"gemini_file_search" as const,
          storeResourceName:v.store_resource_name as string,
          state:v.state as "published"|"retired",
          contentDigestSha256:v.content_digest_sha256 as string,
          approvalReference:v.approval_reference,publishedAt:asIso(v.published_at),
        }:null,
      };
    });
  }

  /**
   * Resolve File Search citation custom metadata to one exact, approved
   * provider document resource. Provider metadata is a lookup hint, not trust:
   * session/agent/store, document IDs, SHA and active approval all match SQL.
   */
  async approvedDocumentFromMetadata(scope:TicketScope,sessionId:string,store:string,
    metadata:Readonly<Record<string,string>>) {
    const agentId=requireUuid(metadata.agentId??"","metadata.agentId");
    const knowledgeId=requireUuid(metadata.knowledgeVersionId??"","metadata.knowledgeVersionId");
    const documentId=requireUuid(metadata.documentId??"","metadata.documentId");
    const versionId=requireUuid(metadata.documentVersionId??"","metadata.documentVersionId");
    if(agentId!==scope.agentId || !/^[a-f0-9]{64}$/.test(metadata.sha256??""))
      throw new PersistenceError("NOT_FOUND","Citation metadata outside approved agent scope");
    if(!/^fileSearchStores\/[A-Za-z0-9_-]+$/.test(store))
      throw new PersistenceError("INVALID_INPUT","Invalid File Search resource");
    return this.db.withAgent(scope.agentId,async client=>{
      const s=await lockedSession(client,scope,sessionId);
      if(await expireIfNeeded(client,s,await clock(client)) ||
         s.knowledge_version_id!==knowledgeId)
        throw new PersistenceError("NOT_FOUND","Citation not pinned to active session");
      const result=await client.query<{
        knowledge_version_id:string;document_id:string;document_version_id:string;
        store_resource_name:string;provider_document_resource_name:string;
        source_sha256:string;title:string;source_locator:string|null;approval_reference:string;
      }>([
        "SELECT k.id AS knowledge_version_id,d.id AS document_id,r.id AS document_version_id,",
        "k.store_resource_name,kd.provider_document_resource_name,r.source_sha256,",
        "d.title,d.source_locator,r.approval_reference",
        "FROM gemini_knowledge_versions k JOIN gemini_knowledge_documents kd",
        "ON kd.agent_id=k.agent_id AND kd.knowledge_version_id=k.id",
        "JOIN gemini_source_revisions r ON r.agent_id=kd.agent_id AND r.id=kd.document_version_id",
        "JOIN gemini_source_documents d ON d.agent_id=r.agent_id AND d.id=r.document_id",
        "WHERE k.agent_id=$1 AND k.id=$2 AND k.state IN ('published','retired')",
        "AND k.store_resource_name=$3 AND d.id=$4 AND r.id=$5",
        "AND r.source_sha256=$6 AND r.approval_status='approved'",
        "AND kd.index_status='active' AND kd.provider_document_resource_name IS NOT NULL",
      ].join(" "),[scope.agentId,knowledgeId,store,documentId,versionId,metadata.sha256]);
      const row=result.rows[0];
      if(!row)throw new PersistenceError("NOT_FOUND","Citation metadata has no authorized source");
      return {
        agentId:scope.agentId,knowledgeVersionId:row.knowledge_version_id,
        documentId:row.document_id,documentVersionId:row.document_version_id,
        providerStoreResourceName:row.store_resource_name,
        providerDocumentResourceName:row.provider_document_resource_name,
        sourceSha256:row.source_sha256,sourceTitle:row.title,
        sourceLocator:row.source_locator,evidenceExcerpt:null,
        approvalReference:row.approval_reference,approvalStatus:"approved" as const,
        indexStatus:"active" as const,
      };
    });
  }

  /** Called with provider annotation IDs only AFTER resolving authorized session. */
  async approvedDocument(scope:TicketScope,sessionId:string,
    storeResourceName:string,documentResourceName:string) {
    requireBounded(storeResourceName,"store",512);
    requireBounded(documentResourceName,"document",1024);
    return this.db.withAgent(scope.agentId,async client=>{
      const s=await lockedSession(client,scope,sessionId);
      if(await expireIfNeeded(client,s,await clock(client)))
        throw new PersistenceError("CONFLICT","AI session expired");
      const result=await client.query<{
        knowledge_version_id:string;document_id:string;document_version_id:string;
        store_resource_name:string;provider_document_resource_name:string;
        source_sha256:string;title:string;source_locator:string|null;
        approval_reference:string;
      }>([
        "SELECT k.id AS knowledge_version_id,d.id AS document_id,r.id AS document_version_id,",
        "k.store_resource_name,kd.provider_document_resource_name,r.source_sha256,",
        "d.title,d.source_locator,r.approval_reference",
        "FROM gemini_knowledge_versions k JOIN gemini_knowledge_documents kd",
        " ON kd.agent_id=k.agent_id AND kd.knowledge_version_id=k.id",
        "JOIN gemini_source_revisions r ON r.agent_id=kd.agent_id AND r.id=kd.document_version_id",
        "JOIN gemini_source_documents d ON d.agent_id=r.agent_id AND d.id=r.document_id",
        "WHERE k.agent_id=$1 AND k.id=$2 AND k.state IN ('published','retired')",
        "AND k.store_resource_name=$3 AND kd.provider_document_resource_name=$4",
        "AND kd.index_status='active' AND r.approval_status='approved'",
      ].join(" "),[scope.agentId,s.knowledge_version_id,storeResourceName,documentResourceName]);
      const r=result.rows[0];
      if(!r) throw new PersistenceError("NOT_FOUND","Authorized approved evidence unavailable");
      return {
        agentId:scope.agentId,knowledgeVersionId:r.knowledge_version_id,
        documentId:r.document_id,documentVersionId:r.document_version_id,
        providerStoreResourceName:r.store_resource_name,
        providerDocumentResourceName:r.provider_document_resource_name,
        sourceSha256:r.source_sha256,sourceTitle:r.title,
        sourceLocator:r.source_locator,evidenceExcerpt:null,
        approvalReference:r.approval_reference,approvalStatus:"approved" as const,
        indexStatus:"active" as const,
      };
    });
  }
}