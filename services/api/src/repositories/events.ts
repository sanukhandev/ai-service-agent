import type { PoolClient } from "pg";
import { PersistenceDatabase, PersistenceError, requireBounded, requireUuid } from "../database/pool.js";
import { asIso, authorizedTicket, cursor, pageSize, type EventRecord, type TicketScope } from "./types.js";

type Payload = Record<string, unknown>;

function safePayload(payload: Payload): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PersistenceError("INVALID_INPUT", "Event payload must be an object");
  }
  const serialized = JSON.stringify(payload);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new PersistenceError("INVALID_INPUT", "Event payload too large");
  }
  return serialized;
}

function eventType(value: string): string {
  requireBounded(value, "eventType", 128);
  if (!/^[a-z][a-z0-9_.-]*$/.test(value)) {
    throw new PersistenceError("INVALID_INPUT", "Invalid event type");
  }
  return value;
}

function mapEvent(row: {
  id: string; ticket_id: string; sequence: string; event_type: string;
  payload: Payload; created_at: Date;
}): EventRecord {
  return {
    id: row.id, ticketId: row.ticket_id, sequence: String(row.sequence),
    eventType: row.event_type, payload: row.payload,
    createdAt: asIso(row.created_at) as string,
  };
}

// Only call while holding a scoped transaction. This updates one ticket row,
// serializing that ticket's event append without a table-wide lock.
export async function appendEventTx(
  client: PoolClient,
  agentId: string,
  ticketId: string,
  type: string,
  payload: Payload,
): Promise<EventRecord> {
  requireUuid(agentId, "agentId");
  requireUuid(ticketId, "ticketId");
  const json = safePayload(payload);
  const next = await client.query<{ last_event_sequence: string }>(
    "UPDATE tickets SET last_event_sequence = last_event_sequence + 1, updated_at = now() WHERE agent_id = $1 AND id = $2 RETURNING last_event_sequence",
    [agentId, ticketId],
  );
  const current = next.rows[0];
  if (!current) throw new PersistenceError("NOT_FOUND", "Ticket not found");
  const inserted = await client.query<{
    id: string; ticket_id: string; sequence: string; event_type: string;
    payload: Payload; created_at: Date;
  }>(
    "INSERT INTO ticket_events (agent_id, ticket_id, sequence, event_type, payload) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id, ticket_id, sequence, event_type, payload, created_at",
    [agentId, ticketId, current.last_event_sequence, eventType(type), json],
  );
  const row = inserted.rows[0];
  if (!row) throw new PersistenceError("DATABASE_ERROR", "Event write returned no row");
  return mapEvent(row);
}

export class TicketEventRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async append(scope: TicketScope, ticketId: string, type: string, payload: Payload): Promise<EventRecord> {
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      return appendEventTx(client, scope.agentId, ticketId, type, payload);
    });
  }

  async listAfter(
    scope: TicketScope, ticketId: string, afterSequence?: string, limit?: number,
  ): Promise<EventRecord[]> {
    const after = cursor(afterSequence);
    const take = pageSize(limit, 200);
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const result = await client.query<{
        id: string; ticket_id: string; sequence: string; event_type: string;
        payload: Payload; created_at: Date;
      }>(
        [
          "SELECT id, ticket_id, sequence, event_type, payload, created_at",
          "FROM ticket_events WHERE agent_id = $1 AND ticket_id = $2 AND sequence > $3::bigint",
          "ORDER BY sequence ASC LIMIT $4",
        ].join(" "),
        [scope.agentId, ticketId, after, take],
      );
      return result.rows.map(mapEvent);
    });
  }

  // The caller must first perform authorization/preflight/consent outside the
  // model. This method only provides an atomic durable event + outbox write.
  async enqueueAuthorizedOperation(
    scope: TicketScope,
    ticketId: string,
    type: string,
    payload: Payload,
    idempotencyKey: string,
  ): Promise<{ event: EventRecord | null; outboxId: string; duplicated: boolean }> {
    requireBounded(idempotencyKey, "idempotencyKey", 200);
    const json = safePayload(payload);
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId, true);
      const existing = await client.query<{ id: string; event_type: string; same_payload: boolean }>(
        "SELECT id, event_type, payload = $4::jsonb AS same_payload FROM event_outbox WHERE agent_id = $1 AND ticket_id = $2 AND idempotency_key = $3",
        [scope.agentId, ticketId, idempotencyKey, json],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.event_type !== type || !previous.same_payload) {
          throw new PersistenceError("CONFLICT", "Idempotency key reused with different operation");
        }
        return { event: null, outboxId: previous.id, duplicated: true };
      }
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO event_outbox (agent_id, ticket_id, event_type, payload, idempotency_key) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id",
        [scope.agentId, ticketId, eventType(type), json, idempotencyKey],
      );
      const outboxId = inserted.rows[0]?.id;
      if (!outboxId) throw new PersistenceError("DATABASE_ERROR", "Outbox write returned no row");
      const event = await appendEventTx(client, scope.agentId, ticketId, "operation.queued", { outboxId, operationType: type });
      return { event, outboxId, duplicated: false };
    });
  }
}
