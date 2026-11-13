import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { authorizedTicket, workerTicketScope, type SourceReference, type TicketScope } from "../repositories/types.js";

export interface PendingTurn {
  id: string;
  agentId: string;
  ticketId: string;
  messageId: string;
  requestId: string;
  leaseToken: string;
}

/** PostgreSQL is authoritative: queues and final replies survive Node restarts. */
export class TurnQueue {
  constructor(private readonly db: PersistenceDatabase) {}

  async enqueue(scope: TicketScope, ticketId: string, messageId: string, requestId: string): Promise<void> {
    await this.db.withAgent(scope.agentId, async client => {
      await authorizedTicket(client, scope, ticketId);
      await client.query(
        "INSERT INTO ticket_turns(agent_id,ticket_id,customer_message_id,request_id) VALUES($1,$2,$3,$4) ON CONFLICT (agent_id,ticket_id,request_id) DO NOTHING",
        [scope.agentId, ticketId, messageId, requestId],
      );
    });
  }

  /** Heal an interrupted two-transaction HTTP acceptance, not a completed turn. */
  async reconcileMissing(): Promise<number> {
    const agents = await this.db.pool.query<{ id: string }>("SELECT id FROM agents WHERE status = 'active'");
    let added = 0;
    for (const agent of agents.rows) {
      added += await this.db.withAgent(agent.id, async client => {
        const result = await client.query(
          [
            "INSERT INTO ticket_turns(agent_id,ticket_id,customer_message_id,request_id)",
            "SELECT m.agent_id,m.ticket_id,m.id,m.request_id FROM ticket_messages m",
            "JOIN tickets t ON t.agent_id=m.agent_id AND t.id=m.ticket_id",
            "WHERE m.agent_id=$1 AND m.role='customer' AND m.request_id IS NOT NULL",
            "AND t.status <> 'closed'",
            "AND NOT EXISTS (SELECT 1 FROM ticket_turns q WHERE q.agent_id=m.agent_id AND q.customer_message_id=m.id)",
            "AND NOT EXISTS (SELECT 1 FROM ticket_messages a WHERE a.agent_id=m.agent_id AND a.ticket_id=m.ticket_id AND a.role='assistant' AND a.request_id=m.request_id)",
            "ON CONFLICT (agent_id,ticket_id,request_id) DO NOTHING",
          ].join(" "),
          [agent.id],
        );
        return result.rowCount ?? 0;
      });
    }
    return added;
  }

  /** Lost provider outcomes are quarantined; never blindly re-run tool side effects. */
  async recoverAbandoned(): Promise<number> {
    const agents = await this.db.pool.query<{ id: string }>("SELECT id FROM agents WHERE status = 'active'");
    let count = 0;
    for (const agent of agents.rows) {
      count += await this.db.withAgent(agent.id, async client => {
        const stale = await client.query<{ id: string; ticket_id: string; request_id: string }>(
          [
            "SELECT id,ticket_id,request_id FROM ticket_turns WHERE agent_id=$1",
            "AND state='processing' AND lease_until < now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20",
          ].join(" "), [agent.id],
        );
        for (const turn of stale.rows) {
          await client.query(
            "UPDATE ticket_turns SET state='uncertain',error_code='PROCESS_INTERRUPTED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND agent_id=$2",
            [turn.id, agent.id],
          );
          await client.query(
            "UPDATE tickets SET status='open',updated_at=now() WHERE agent_id=$1 AND id=$2 AND status='processing'",
            [agent.id, turn.ticket_id],
          );
          await appendEventTx(client, agent.id, turn.ticket_id, "assistant.failed", {
            requestId: turn.request_id, code: "PROCESS_INTERRUPTED",
            message: "The previous request was interrupted. Its outcome needs review before retrying.",
          });
        }
        return stale.rows.length;
      });
    }
    return count;
  }

  async claim(): Promise<PendingTurn | null> {
    const agents = await this.db.pool.query<{ id: string }>("SELECT id FROM agents WHERE status = 'active'");
    for (const agent of agents.rows) {
      const found = await this.db.withAgent(agent.id, async client => {
        const selected = await client.query<{
          id: string; ticket_id: string; customer_message_id: string; request_id: string; lease_token: string;
        }>(
          [
            "WITH candidate AS (SELECT q.id FROM ticket_turns q",
            "JOIN tickets t ON t.agent_id=q.agent_id AND t.id=q.ticket_id",
            "JOIN ticket_messages m ON m.agent_id=q.agent_id AND m.id=q.customer_message_id",
            "WHERE q.agent_id=$1 AND q.state='queued' AND t.status <> 'closed'",
            "AND NOT EXISTS (SELECT 1 FROM ticket_turns earlier WHERE earlier.agent_id=q.agent_id",
            "AND earlier.ticket_id=q.ticket_id AND earlier.state NOT IN ('completed','failed')",
            "AND EXISTS (SELECT 1 FROM ticket_messages em WHERE em.agent_id=earlier.agent_id",
            "AND em.id=earlier.customer_message_id AND em.message_sequence<m.message_sequence))",
            "ORDER BY m.message_sequence,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1)",
            "UPDATE ticket_turns q SET state='processing',attempt_count=q.attempt_count+1,",
            "lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',updated_at=now()",
            "FROM candidate c WHERE q.id=c.id",
            "RETURNING q.id,q.ticket_id,q.customer_message_id,q.request_id,q.lease_token",
          ].join(" "), [agent.id],
        );
        const q=selected.rows[0];
        if (!q) return null;
        const scope=workerTicketScope(agent.id,q.ticket_id);
        await authorizedTicket(client,scope,q.ticket_id,true);
        await client.query(
          "UPDATE tickets SET status='processing',updated_at=now() WHERE agent_id=$1 AND id=$2",
          [agent.id,q.ticket_id],
        );
        await appendEventTx(client,agent.id,q.ticket_id,"assistant.processing",{requestId:q.request_id});
        return {id:q.id,agentId:agent.id,ticketId:q.ticket_id,messageId:q.customer_message_id,requestId:q.request_id,leaseToken:q.lease_token};
      });
      if (found) return found;
    }
    return null;
  }

  async currentCustomerMessage(turn: PendingTurn): Promise<string> {
    return this.db.withAgent(turn.agentId, async client => {
      const result = await client.query<{ content: string }>(
        "SELECT content FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND role='customer'",
        [turn.agentId,turn.ticketId,turn.messageId],
      );
      if (!result.rows[0]) throw new PersistenceError("NOT_FOUND","Queued customer message unavailable");
      return result.rows[0].content;
    });
  }

  async responseCursor(turn: PendingTurn): Promise<string | null> {
    return this.db.withAgent(turn.agentId, async client => {
      const result = await client.query<{ last_response_id: string | null }>(
        "SELECT last_response_id FROM ticket_model_sessions WHERE agent_id=$1 AND ticket_id=$2 AND provider='foundry'",
        [turn.agentId,turn.ticketId],
      );
      return result.rows[0]?.last_response_id ?? null;
    });
  }

  /** Persist message, provider cursor, queue state and SSE event atomically. */
  async complete(
    turn: PendingTurn, text: string, refs: readonly SourceReference[],
    expectedCursor: string | null, responseId: string, versionId: string,
  ): Promise<void> {
    if (!text.trim() || text.length>30000 || !/^resp_[A-Za-z0-9_-]+$/.test(responseId)) {
      throw new PersistenceError("INVALID_INPUT","Invalid model completion");
    }
    if (refs.length > 50 || Buffer.byteLength(JSON.stringify(refs),"utf8") > 16000) {
      throw new PersistenceError("INVALID_INPUT","Invalid source reference payload");
    }
    await this.db.withAgent(turn.agentId, async client => {
      const scope=workerTicketScope(turn.agentId,turn.ticketId);
      await authorizedTicket(client,scope,turn.ticketId,true);
      const active=await client.query<{ id: string }>(
        "SELECT id FROM ticket_turns WHERE agent_id=$1 AND id=$2 AND state='processing' AND lease_token=$3 FOR UPDATE",
        [turn.agentId,turn.id,turn.leaseToken],
      );
      if (!active.rows[0]) throw new PersistenceError("CONFLICT","Turn lease lost");
      const existing=await client.query<{ id: string }>(
        "SELECT id FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND role='assistant' AND request_id=$3",
        [turn.agentId,turn.ticketId,turn.requestId],
      );
      if (existing.rows[0]) throw new PersistenceError("CONFLICT","Assistant message already committed");
      const cursor=await client.query<{ last_response_id: string }>(
        [
          "INSERT INTO ticket_model_sessions(agent_id,ticket_id,agent_version_id,provider,last_response_id)",
          "VALUES($1,$2,$3,'foundry',$5)",
          "ON CONFLICT(agent_id,ticket_id,provider) DO UPDATE SET",
          "last_response_id=EXCLUDED.last_response_id,updated_at=now()",
          "WHERE ticket_model_sessions.last_response_id IS NOT DISTINCT FROM $4",
          "RETURNING last_response_id",
        ].join(" "),[turn.agentId,turn.ticketId,versionId,expectedCursor,responseId],
      );
      if (!cursor.rows[0]) throw new PersistenceError("CONFLICT","Foundry continuation cursor changed");
      const sequence=await client.query<{ last_message_sequence: string }>(
        "UPDATE tickets SET last_message_sequence=last_message_sequence+1,status='awaiting_customer',updated_at=now() WHERE agent_id=$1 AND id=$2 RETURNING last_message_sequence",
        [turn.agentId,turn.ticketId],
      );
      const saved=await client.query<{ id: string; created_at: Date }>(
        [
          "INSERT INTO ticket_messages(agent_id,ticket_id,role,content,request_id,source_references,message_sequence)",
          "VALUES($1,$2,'assistant',$3,$4,$5::jsonb,$6) RETURNING id,created_at",
        ].join(" "),[turn.agentId,turn.ticketId,text,turn.requestId,JSON.stringify(refs),sequence.rows[0]?.last_message_sequence],
      );
      const message=saved.rows[0];
      if (!message) throw new PersistenceError("DATABASE_ERROR","Assistant insert failed");
      await client.query(
        "UPDATE ticket_turns SET state='completed',provider_response_id=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE agent_id=$1 AND id=$2",
        [turn.agentId,turn.id,responseId],
      );
      const envelope={message:{id:message.id,role:"assistant",text,createdAt:message.created_at.toISOString(),sourceReferences:refs}};
      const payload=Buffer.byteLength(JSON.stringify(envelope),"utf8") <= 30000
        ? envelope : {messageId:message.id,requestId:turn.requestId};
      await appendEventTx(client,turn.agentId,turn.ticketId,"assistant.message",payload);
      await appendEventTx(client,turn.agentId,turn.ticketId,"ticket.updated",{status:"awaiting_customer"});
    });
  }

  async fail(turn: PendingTurn, code: string, uncertain = false): Promise<void> {
    await this.db.withAgent(turn.agentId,async client => {
      const current=await client.query(
        "UPDATE ticket_turns SET state=$4,error_code=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE agent_id=$1 AND id=$2 AND lease_token=$3 AND state='processing' RETURNING id",
        [turn.agentId,turn.id,turn.leaseToken,uncertain?"uncertain":"failed",code],
      );
      if (!current.rows[0]) return;
      await client.query(
        "UPDATE tickets SET status='open',updated_at=now() WHERE agent_id=$1 AND id=$2",
        [turn.agentId,turn.ticketId],
      );
      await appendEventTx(client,turn.agentId,turn.ticketId,"assistant.failed",{
        requestId:turn.requestId,code,
        message: uncertain ? "The model operation has an uncertain outcome. Please contact support before retrying."
          : "Sara could not complete that response. You can send another message.",
      });
      await appendEventTx(client,turn.agentId,turn.ticketId,"ticket.updated",{status:"open"});
    });
  }
}
