/**
 * P2/P3 PostgreSQL adapters for Node-owned intent catalog and customer facts.
 * These are not wired into the Fastify request lifecycle until P2/P3.
 *
 * IMPORTANT: Use a dedicated, non-superuser Postgres runtime role without
 * BYPASSRLS. 001_core.sql initializes the schema as migration owner only.
 */
import type { Pool, PoolClient } from "pg";
import type {
  CatalogRepository, IntentEntry, IntentRequirement, OfferingEntry,
  TicketFact, TicketFactRepository, TicketIntentRepository,
} from "./intent-tools.js";

type ScopedWork<T> = (client: PoolClient) => Promise<T>;

export class AgentScopedDatabase {
  constructor(private readonly pool: Pool) {}

  async withinAgent<T>(agentId: string, work: ScopedWork<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface IntentRow {
  id: string;
  intent_key: string;
  name: string;
  description: string;
  examples: string[];
  allowed_actions: string[];
}
interface RequirementRow {
  intent_id: string;
  requirement_key: string;
  label: string;
  value_type: IntentRequirement["type"];
  required_for: string[];
  guidance: string | null;
}
interface OfferingRow {
  offering_key: string;
  label: string;
  description: string;
  currency: string | null;
  amount: string | null;
  price_revision: number | null;
  conditions: string | null;
}

export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly db: AgentScopedDatabase) {}

  async listIntents(agentId: string, catalogVersion: string): Promise<IntentEntry[]> {
    return this.db.withinAgent(agentId, async (client) => {
      // A retired published revision remains readable for an existing ticket.
      // Never read a draft revision from customer conversations.
      const intents = await client.query<IntentRow>(
        `
        SELECT i.id, i.intent_key, i.name, i.description, i.examples, i.allowed_actions
        FROM intents i
        JOIN intent_catalog_versions v
          ON v.agent_id = i.agent_id AND v.id = i.catalog_version_id
        WHERE i.agent_id = $1 AND v.revision::text = $2
          AND v.status IN ('published', 'retired')
        ORDER BY i.intent_key
        `,
        [agentId, catalogVersion],
      );

      if (intents.rows.length === 0) return [];
      const reqs = await client.query<RequirementRow>(
        `
        SELECT intent_id, requirement_key, label, value_type, required_for, guidance
        FROM intent_requirements
        WHERE agent_id = $1 AND intent_id = ANY($2::uuid[])
        ORDER BY intent_id, requirement_key
        `,
        [agentId, intents.rows.map((item) => item.id)],
      );
      const byIntent = new Map<string, IntentRequirement[]>();
      for (const req of reqs.rows) {
        const items = byIntent.get(req.intent_id) ?? [];
        items.push({
          key: req.requirement_key,
          label: req.label,
          type: req.value_type,
          requiredFor: req.required_for,
          hint: req.guidance ?? undefined,
        });
        byIntent.set(req.intent_id, items);
      }
      return intents.rows.map((row) => ({
        key: row.intent_key,
        name: row.name,
        description: row.description,
        examplePhrases: row.examples,
        requirements: byIntent.get(row.id) ?? [],
        allowedActions: row.allowed_actions,
      }));
    });
  }

  async listOfferings(
    agentId: string,
    catalogVersion: string,
    intentKey?: string,
  ): Promise<OfferingEntry[]> {
    return this.db.withinAgent(agentId, async (client) => {
      const found = await client.query<OfferingRow>(
        `
        SELECT o.offering_key, o.label, o.description,
          p.currency, p.amount::text AS amount,
          p.revision AS price_revision, p.conditions
        FROM offerings o
        JOIN offering_catalog_versions v
          ON v.agent_id = o.agent_id AND v.id = o.catalog_version_id
        LEFT JOIN LATERAL (
          SELECT currency, amount, revision, conditions
          FROM offering_price_revisions p
          WHERE p.agent_id = o.agent_id AND p.offering_id = o.id
            AND p.effective_from <= now()
            AND (p.effective_to IS NULL OR p.effective_to > now())
          ORDER BY p.revision DESC
          LIMIT 1
        ) p ON true
        WHERE o.agent_id = $1 AND v.revision::text = $2
          AND v.status IN ('published', 'retired')
          AND ($3::text IS NULL OR o.intent_key = $3)
        ORDER BY o.offering_key
        `,
        [agentId, catalogVersion, intentKey ?? null],
      );
      return found.rows.map((row) => ({
        key: row.offering_key,
        label: row.label,
        description: row.description,
        ...(row.amount === null || row.currency === null
          ? {}
          : {
              price: {
                currency: row.currency.trim(),
                amount: Number(row.amount),
                revision: String(row.price_revision),
                conditions: row.conditions ?? undefined,
              },
            }),
      }));
    });
  }
}

interface FactRow {
  id: string;
  fact_key: string;
  value: string | number | boolean;
  source_message_id: string;
  verification_status: TicketFact["verification"];
  updated_at: Date;
}

export class PgTicketFactRepository implements TicketFactRepository {
  constructor(private readonly db: AgentScopedDatabase) {}

  async listFacts(agentId: string, ticketId: string): Promise<TicketFact[]> {
    return this.db.withinAgent(agentId, async (client) => {
      const result = await client.query<FactRow>(
        `
        SELECT id, fact_key, value, source_message_id, verification_status, updated_at
        FROM ticket_facts
        WHERE agent_id = $1 AND ticket_id = $2
        ORDER BY fact_key
        `,
        [agentId, ticketId],
      );
      return result.rows.map((row) => this.mapFact(row));
    });
  }

  async recordCustomerFacts(
    agentId: string,
    ticketId: string,
    sourceMessageId: string,
    facts: ReadonlyArray<{ key: string; value: string | number | boolean }>,
  ): Promise<TicketFact[]> {
    return this.db.withinAgent(agentId, async (client) => {
      const source = await client.query<{ role: string }>(
        `
        SELECT role FROM ticket_messages
        WHERE agent_id = $1 AND ticket_id = $2 AND id = $3
        FOR SHARE
        `,
        [agentId, ticketId, sourceMessageId],
      );
      if (source.rows.length !== 1 || source.rows[0]?.role !== "customer") {
        throw new Error("Customer message provenance is required");
      }

      const out: TicketFact[] = [];
      for (const candidate of facts) {
        const previous = await client.query<{ value: unknown }>(
          `
          SELECT value FROM ticket_facts
          WHERE agent_id = $1 AND ticket_id = $2 AND fact_key = $3
          FOR UPDATE
          `,
          [agentId, ticketId, candidate.key],
        );
        const upserted = await client.query<FactRow>(
          `
          INSERT INTO ticket_facts (
            agent_id, ticket_id, fact_key, value,
            verification_status, source_message_id
          ) VALUES ($1, $2, $3, $4::jsonb, 'customer_stated', $5)
          ON CONFLICT (agent_id, ticket_id, fact_key)
          DO UPDATE SET
            value = EXCLUDED.value,
            verification_status = 'customer_stated',
            source_message_id = EXCLUDED.source_message_id,
            updated_at = now()
          RETURNING id, fact_key, value, source_message_id, verification_status, updated_at
          `,
          [agentId, ticketId, candidate.key, JSON.stringify(candidate.value), sourceMessageId],
        );
        const stored = upserted.rows[0];
        if (!stored) throw new Error("Ticket fact write returned no record");

        await client.query(
          `
          INSERT INTO ticket_fact_events (
            agent_id, ticket_id, fact_id, old_value, new_value, source_message_id
          ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
          `,
          [
            agentId, ticketId, stored.id,
            previous.rows[0] ? JSON.stringify(previous.rows[0].value) : null,
            JSON.stringify(candidate.value), sourceMessageId,
          ],
        );
        out.push(this.mapFact(stored));
      }
      return out;
    });
  }

  private mapFact(row: FactRow): TicketFact {
    return {
      key: row.fact_key,
      value: row.value,
      sourceMessageId: row.source_message_id,
      verification: row.verification_status,
      updatedAt: row.updated_at.toISOString(),
    };
  }
}


/** Save one current business goal for the ticket without any external side effect. */
export class PgTicketIntentRepository implements TicketIntentRepository {
  constructor(private readonly db: AgentScopedDatabase) {}

  async selectIntent(
    agentId: string,
    ticketId: string,
    catalogVersion: string,
    intentKey: string,
  ): Promise<{ intentKey: string; status: string }> {
    return this.db.withinAgent(agentId, async (client) => {
      const resolved = await client.query<{ id: string }>(
        `
        SELECT i.id
        FROM intents i JOIN intent_catalog_versions v
          ON v.agent_id = i.agent_id AND v.id = i.catalog_version_id
        WHERE i.agent_id = $1 AND v.revision::text = $2
          AND v.status IN ('published', 'retired') AND i.intent_key = $3
        LIMIT 1
        `,
        [agentId, catalogVersion, intentKey],
      );
      const target = resolved.rows[0];
      if (!target) throw new Error("Unsupported intent or catalog revision");

      // A ticket can later add multiple goals; the POC has one active goal.
      await client.query(
        `
        UPDATE ticket_intents SET status = 'superseded'
        WHERE agent_id = $1 AND ticket_id = $2 AND status = 'active'
          AND intent_id <> $3
        `,
        [agentId, ticketId, target.id],
      );
      await client.query(
        `
        INSERT INTO ticket_intents (agent_id, ticket_id, intent_id, status)
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (agent_id, ticket_id, intent_id)
        DO UPDATE SET status = 'active', selected_at = now()
        `,
        [agentId, ticketId, target.id],
      );
      return { intentKey, status: "active" };
    });
  }
}
