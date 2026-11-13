import { PersistenceDatabase, PersistenceError, requireBounded, requireUuid } from "../database/pool.js";
import { appendEventTx } from "./events.js";
import {
  asIso, authorizedTicket, assertAgentActive, cursor, pageSize,
  type MessageRecord, type SourceReference, type TicketScope,
} from "./types.js";

interface MessageRow {
  id: string;
  ticket_id: string;
  role: "customer" | "assistant";
  content: string;
  request_id: string | null;
  message_sequence: string;
  source_references: SourceReference[];
  created_at: Date;
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id, ticketId: row.ticket_id, role: row.role,
    text: row.content, requestId: row.request_id,
    sequence: String(row.message_sequence),
    sourceReferences: row.source_references,
    createdAt: asIso(row.created_at) as string,
  };
}

function assertReferences(refs: readonly SourceReference[]): void {
  if (!Array.isArray(refs) || refs.length > 50) {
    throw new PersistenceError("INVALID_INPUT", "Invalid source references");
  }
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") throw new PersistenceError("INVALID_INPUT", "Invalid source reference");
    requireBounded(ref.sourceId, "sourceId", 512);
    for (const field of [ref.title, ref.uri, ref.revision]) {
      if (field !== undefined && field !== null && (typeof field !== "string" || field.length > 2048)) {
        throw new PersistenceError("INVALID_INPUT", "Invalid source reference field");
      }
    }
  }
}

export class TicketMessageRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async createCustomerMessage(
    scope: TicketScope, ticketId: string, requestId: string, text: string,
  ): Promise<{ message: MessageRecord; duplicated: boolean }> {
    requireUuid(requestId, "requestId");
    requireBounded(text, "message", 12_000);
    return this.write(scope, ticketId, "customer", requestId, text, []);
  }

  async createAssistantMessage(
    scope: TicketScope, ticketId: string, requestId: string, text: string,
    sourceReferences: readonly SourceReference[],
  ): Promise<{ message: MessageRecord; duplicated: boolean }> {
    requireUuid(requestId, "requestId");
    requireBounded(text, "message", 30_000);
    assertReferences(sourceReferences);
    return this.write(scope, ticketId, "assistant", requestId, text, [...sourceReferences]);
  }

  private async write(
    scope: TicketScope, ticketId: string, role: MessageRow["role"],
    requestId: string, text: string, refs: SourceReference[],
  ): Promise<{ message: MessageRecord; duplicated: boolean }> {
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId, true);
      const prior = await client.query<MessageRow & { identical_refs: boolean }>(
        "SELECT *, source_references = $5::jsonb AS identical_refs FROM ticket_messages WHERE agent_id = $1 AND ticket_id = $2 AND role = $3 AND request_id = $4",
        [scope.agentId, ticketId, role, requestId, JSON.stringify(refs)],
      );
      const old = prior.rows[0];
      if (old) {
        if (old.content !== text || !old.identical_refs) {
          throw new PersistenceError("CONFLICT", "Request ID already used for different content");
        }
        return { message: mapMessage(old), duplicated: true };
      }
      if (ticket["status"] === "closed") throw new PersistenceError("CONFLICT", "Ticket is closed");
      await assertAgentActive(client, scope.agentId);
      const next = await client.query<{ last_message_sequence: string }>(
        "UPDATE tickets SET last_message_sequence = last_message_sequence + 1, updated_at = now() WHERE agent_id = $1 AND id = $2 RETURNING last_message_sequence",
        [scope.agentId, ticketId],
      );
      const sequence = next.rows[0]?.last_message_sequence;
      if (!sequence) throw new PersistenceError("DATABASE_ERROR", "Message sequence unavailable");
      const saved = await client.query<MessageRow>(
        [
          "INSERT INTO ticket_messages (agent_id, ticket_id, role, content, request_id, source_references, message_sequence)",
          "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
          "RETURNING *",
        ].join(" "),
        [scope.agentId, ticketId, role, text, requestId, JSON.stringify(refs), sequence],
      );
      const row = saved.rows[0];
      if (!row) throw new PersistenceError("DATABASE_ERROR", "Message write returned no row");
      // Frozen P0 SSE protocol: assistant.message carries the durable ChatMessage.
      // If it exceeds the event size limit, the consumer re-fetches the
      // authorized ticket snapshot using the ID-only payload.
      const customerEvent = { messageId: row.id, requestId, sequence: String(row.message_sequence) };
      const message = mapMessage(row);
      const assistantEnvelope = {
        message: {
          id: message.id, role: message.role, text: message.text,
          createdAt: message.createdAt, sourceReferences: message.sourceReferences,
        },
      };
      const assistantEvent = Buffer.byteLength(JSON.stringify(assistantEnvelope), "utf8") <= 30_000
        ? assistantEnvelope : customerEvent;
      await appendEventTx(client, scope.agentId, ticketId,
        role === "customer" ? "message.accepted" : "assistant.message",
        role === "customer" ? customerEvent : assistantEvent);
      return { message: mapMessage(row), duplicated: false };
    });
  }

  async getMessageByRequestId(
    scope: TicketScope, ticketId: string, role: MessageRow["role"], requestId: string,
  ): Promise<MessageRecord | null> {
    requireUuid(requestId, "requestId");
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const result = await client.query<MessageRow>(
        "SELECT * FROM ticket_messages WHERE agent_id = $1 AND ticket_id = $2 AND role = $3 AND request_id = $4",
        [scope.agentId, ticketId, role, requestId],
      );
      return result.rows[0] ? mapMessage(result.rows[0]) : null;
    });
  }

  async listTicketMessages(
    scope: TicketScope, ticketId: string, afterSequence?: string, limit?: number,
  ): Promise<MessageRecord[]> {
    const after = cursor(afterSequence);
    const take = pageSize(limit, 200);
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const result = await client.query<MessageRow>(
        [
          "SELECT * FROM ticket_messages WHERE agent_id = $1 AND ticket_id = $2",
          "AND message_sequence > $3::bigint ORDER BY message_sequence ASC LIMIT $4",
        ].join(" "),
        [scope.agentId, ticketId, after, take],
      );
      return result.rows.map(mapMessage);
    });
  }

  async recentMessages(scope: TicketScope, ticketId: string, limit = 20): Promise<MessageRecord[]> {
    const take = pageSize(limit, 100);
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const result = await client.query<MessageRow>(
        [
          "SELECT * FROM ticket_messages WHERE agent_id = $1 AND ticket_id = $2",
          "ORDER BY message_sequence DESC LIMIT $3",
        ].join(" "),
        [scope.agentId, ticketId, take],
      );
      return result.rows.reverse().map(mapMessage);
    });
  }
}
