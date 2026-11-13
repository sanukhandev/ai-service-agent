import { PersistenceDatabase, PersistenceError, requireBounded, requireUuid } from "../database/pool.js";
import { appendEventTx } from "./events.js";
import { asIso, authorizedTicket, type TicketScope } from "./types.js";

export type FactValue = string | number | boolean;
export type Verification = "customer_stated" | "verified" | "disputed";

export interface StoredFact {
  key: string;
  value: FactValue;
  verification: Verification;
  sourceMessageId: string;
  updatedAt: string;
}

export interface ConversationContext {
  activeIntent: string | null;
  intentCatalogRevision: string | null;
  offeringCatalogRevision: string | null;
  knownFacts: Record<string, FactValue>;
  facts: StoredFact[];
  missingRequirements: string[];
  summary: { revision: number; text: string } | null;
}

interface FactRow {
  id: string; fact_key: string; value: FactValue; verification_status: Verification;
  source_message_id: string; updated_at: Date;
}
function mapFact(row: FactRow): StoredFact {
  return {
    key: row.fact_key, value: row.value, verification: row.verification_status,
    sourceMessageId: row.source_message_id, updatedAt: asIso(row.updated_at) as string,
  };
}

export class ConversationContextRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async read(scope: TicketScope, ticketId: string, operationKey?: string): Promise<ConversationContext> {
    if (operationKey !== undefined) requireBounded(operationKey, "operationKey", 128);
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId);
      const selected = await client.query<{ id: string; intent_key: string }>(
        [
          "SELECT i.id, i.intent_key FROM ticket_intents ti",
          "JOIN intents i ON i.agent_id = ti.agent_id AND i.id = ti.intent_id",
          "WHERE ti.agent_id = $1 AND ti.ticket_id = $2 AND ti.status = 'active'",
          "AND i.catalog_version_id = $3 ORDER BY ti.selected_at DESC LIMIT 1",
        ].join(" "),
        [scope.agentId, ticketId, ticket["intent_catalog_version_id"]],
      );
      const facts = await client.query<FactRow>(
        "SELECT id, fact_key, value, verification_status, source_message_id, updated_at FROM ticket_facts WHERE agent_id = $1 AND ticket_id = $2 ORDER BY fact_key",
        [scope.agentId, ticketId],
      );
      const stored = facts.rows.map(mapFact);
      const present = new Set(stored
        .filter((fact) => fact.verification !== "disputed" &&
          (typeof fact.value !== "string" || fact.value.trim().length > 0))
        .map((fact) => fact.key));
      const intent = selected.rows[0];
      const requirements = intent
        ? await client.query<{ requirement_key: string }>(
          [
            "SELECT requirement_key FROM intent_requirements",
            "WHERE agent_id = $1 AND intent_id = $2",
            "AND ($3::text IS NULL OR $3 = ANY(required_for))",
            "ORDER BY requirement_key",
          ].join(" "),
          [scope.agentId, intent.id, operationKey ?? null],
        ) : null;
      const summary = await client.query<{ revision: number; summary: string }>(
        "SELECT revision, summary FROM ticket_summaries WHERE agent_id = $1 AND ticket_id = $2 ORDER BY revision DESC LIMIT 1",
        [scope.agentId, ticketId],
      );
      const catalogs = await client.query<{
        intent_revision: number | null; offering_revision: number | null;
      }>(
        [
          "SELECT ic.revision AS intent_revision, oc.revision AS offering_revision FROM tickets t",
          "LEFT JOIN intent_catalog_versions ic ON ic.agent_id = t.agent_id AND ic.id = t.intent_catalog_version_id",
          "LEFT JOIN offering_catalog_versions oc ON oc.agent_id = t.agent_id AND oc.id = t.offering_catalog_version_id",
          "WHERE t.agent_id = $1 AND t.id = $2",
        ].join(" "),
        [scope.agentId, ticketId],
      );
      const revisions = catalogs.rows[0];
      return {
        activeIntent: intent?.intent_key ?? null,
        intentCatalogRevision: revisions?.intent_revision == null ? null : String(revisions.intent_revision),
        offeringCatalogRevision: revisions?.offering_revision == null ? null : String(revisions.offering_revision),
        knownFacts: Object.fromEntries(stored.filter((f) => present.has(f.key))
          .map((f) => [f.key, f.value])),
        facts: stored,
        missingRequirements: (requirements?.rows ?? [])
          .map((r) => r.requirement_key).filter((key) => !present.has(key)),
        summary: summary.rows[0]
          ? { revision: summary.rows[0].revision, text: summary.rows[0].summary } : null,
      };
    });
  }

  // Models can propose an intent, but only a currently pinned catalog entry
  // can be selected. Selection never triggers external operations.
  async selectIntent(scope: TicketScope, ticketId: string, intentKey: string): Promise<void> {
    requireBounded(intentKey, "intentKey", 128);
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId, true);
      if (ticket["status"] === "closed") throw new PersistenceError("CONFLICT", "Ticket is closed");
      const selected = await client.query<{ id: string }>(
        [
          "SELECT i.id FROM intents i JOIN intent_catalog_versions v",
          "ON v.agent_id = i.agent_id AND v.id = i.catalog_version_id",
          "WHERE i.agent_id = $1 AND i.catalog_version_id = $2 AND i.intent_key = $3",
          "AND v.status IN ('published', 'retired')",
        ].join(" "),
        [scope.agentId, ticket["intent_catalog_version_id"], intentKey],
      );
      const intentId = selected.rows[0]?.id;
      if (!intentId) throw new PersistenceError("NOT_FOUND", "Intent not available in pinned catalog");
      await client.query(
        "UPDATE ticket_intents SET status = 'superseded' WHERE agent_id = $1 AND ticket_id = $2 AND status = 'active' AND intent_id <> $3",
        [scope.agentId, ticketId, intentId],
      );
      await client.query(
        [
          "INSERT INTO ticket_intents (agent_id, ticket_id, intent_id, status)",
          "VALUES ($1, $2, $3, 'active')",
          "ON CONFLICT (agent_id, ticket_id, intent_id)",
          "DO UPDATE SET status = 'active', selected_at = now()",
        ].join(" "),
        [scope.agentId, ticketId, intentId],
      );
      await appendEventTx(client, scope.agentId, ticketId, "ticket.intent.selected", { intentKey });
    });
  }

  async recordCustomerFacts(
    scope: TicketScope, ticketId: string, sourceMessageId: string,
    facts: ReadonlyArray<{ key: string; value: FactValue }>,
  ): Promise<StoredFact[]> {
    requireUuid(sourceMessageId, "sourceMessageId");
    if (!Array.isArray(facts) || facts.length < 1 || facts.length > 12) {
      throw new PersistenceError("INVALID_INPUT", "Invalid fact batch");
    }
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId, true);
      if (ticket["status"] === "closed") throw new PersistenceError("CONFLICT", "Ticket is closed");
      const source = await client.query<{ role: string }>(
        "SELECT role FROM ticket_messages WHERE agent_id = $1 AND ticket_id = $2 AND id = $3",
        [scope.agentId, ticketId, sourceMessageId],
      );
      if (source.rows[0]?.role !== "customer") {
        throw new PersistenceError("CONFLICT", "Customer message provenance required");
      }
      const selected = await client.query<{ id: string }>(
        [
          "SELECT i.id FROM ticket_intents ti JOIN intents i",
          "ON i.agent_id = ti.agent_id AND i.id = ti.intent_id",
          "WHERE ti.agent_id = $1 AND ti.ticket_id = $2 AND ti.status = 'active'",
          "AND i.catalog_version_id = $3",
        ].join(" "),
        [scope.agentId, ticketId, ticket["intent_catalog_version_id"]],
      );
      const intentId = selected.rows[0]?.id;
      if (!intentId) throw new PersistenceError("CONFLICT", "Select a pinned intent first");
      const permitted = await client.query<{ requirement_key: string; value_type: string }>(
        "SELECT requirement_key, value_type FROM intent_requirements WHERE agent_id = $1 AND intent_id = $2",
        [scope.agentId, intentId],
      );
      const keys = new Map(permitted.rows.map((r) => [r.requirement_key, r.value_type]));
      const seen = new Set<string>();
      const result: StoredFact[] = [];
      for (const fact of facts) {
        requireBounded(fact.key, "factKey", 128);
        if (!keys.has(fact.key) || seen.has(fact.key)) {
          throw new PersistenceError("INVALID_INPUT", "Unknown or duplicated fact key");
        }
        seen.add(fact.key);
        const value = fact.value;
        const expectedType = keys.get(fact.key);
        if ((expectedType === "number" && typeof value !== "number") ||
          ((expectedType === "email" || expectedType === "text" || expectedType === "choice") && typeof value !== "string") ||
          (expectedType === "email" && (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))) {
          throw new PersistenceError("INVALID_INPUT", "Fact value does not match published requirement type");
        }
        if ((typeof value !== "string" || value.length > 1000) &&
          (typeof value !== "number" || !Number.isFinite(value)) &&
          typeof value !== "boolean") {
          throw new PersistenceError("INVALID_INPUT", "Invalid fact value");
        }
        const previous = await client.query<{ value: FactValue; verification_status: Verification }>(
          "SELECT value, verification_status FROM ticket_facts WHERE agent_id = $1 AND ticket_id = $2 AND fact_key = $3 FOR UPDATE",
          [scope.agentId, ticketId, fact.key],
        );
        const old = previous.rows[0];
        const saved = await client.query<FactRow>(
          [
            "INSERT INTO ticket_facts (agent_id, ticket_id, fact_key, value, verification_status, source_message_id)",
            "VALUES ($1, $2, $3, $4::jsonb, 'customer_stated', $5)",
            "ON CONFLICT (agent_id, ticket_id, fact_key)",
            "DO UPDATE SET value = EXCLUDED.value, verification_status = 'customer_stated',",
            "source_message_id = EXCLUDED.source_message_id, updated_at = now()",
            "RETURNING id, fact_key, value, verification_status, source_message_id, updated_at",
          ].join(" "),
          [scope.agentId, ticketId, fact.key, JSON.stringify(value), sourceMessageId],
        );
        const row = saved.rows[0];
        if (!row) throw new PersistenceError("DATABASE_ERROR", "Fact write returned no row");
        await client.query(
          [
            "INSERT INTO ticket_fact_events (agent_id, ticket_id, fact_id, old_value, new_value,",
            "source_message_id, old_verification_status, new_verification_status)",
            "VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, 'customer_stated')",
          ].join(" "),
          [scope.agentId, ticketId, row.id, old ? JSON.stringify(old.value) : null,
            JSON.stringify(value), sourceMessageId, old?.verification_status ?? null],
        );
        result.push(mapFact(row));
      }
      await appendEventTx(client, scope.agentId, ticketId, "ticket.facts.updated",
        { keys: result.map((r) => r.key), sourceMessageId });
      return result;
    });
  }

  async appendSummary(scope: TicketScope, ticketId: string, text: string): Promise<{ revision: number }> {
    requireBounded(text, "summary", 30_000);
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId, true);
      const result = await client.query<{ revision: number }>(
        [
          "INSERT INTO ticket_summaries (agent_id, ticket_id, revision, summary)",
          "SELECT $1, $2, COALESCE(MAX(revision), 0) + 1, $3 FROM ticket_summaries",
          "WHERE agent_id = $1 AND ticket_id = $2 RETURNING revision",
        ].join(" "),
        [scope.agentId, ticketId, text],
      );
      const revision = result.rows[0]?.revision;
      if (!revision) throw new PersistenceError("DATABASE_ERROR", "Summary write returned no row");
      await appendEventTx(client, scope.agentId, ticketId, "ticket.summary.updated", { revision });
      return { revision };
    });
  }

  async summaryHistory(scope: TicketScope, ticketId: string, limit = 20): Promise<Array<{ revision: number; text: string; createdAt: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PersistenceError("INVALID_INPUT", "Invalid summary limit");
    }
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const found = await client.query<{ revision: number; summary: string; created_at: Date }>(
        "SELECT revision, summary, created_at FROM ticket_summaries WHERE agent_id = $1 AND ticket_id = $2 ORDER BY revision DESC LIMIT $3",
        [scope.agentId, ticketId, limit],
      );
      return found.rows.map((r) => ({ revision: r.revision, text: r.summary, createdAt: asIso(r.created_at) as string }));
    });
  }
}
