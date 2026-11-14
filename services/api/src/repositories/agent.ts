import type { PoolClient } from "pg";
import { PersistenceDatabase, PersistenceError, dbError, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "./types.js";

export interface AgentIdentity {
  id: string;
  key: string;
  displayName: string;
  status: "draft" | "active" | "paused" | "archived";
}

/** Published Gemini agent configuration; business catalog ownership stays in Node. */
export interface AgentBinding {
  agentId: string;
  versionId: string;
  versionNumber: number;
  provider: "gemini";
  modelId: string;
  personaVersion: string;
  knowledgeVersionId: string | null;
  personaConfig: Record<string, unknown>;
  intentCatalogVersionId: string | null;
  intentCatalogRevision: string | null;
  offeringCatalogVersionId: string | null;
  offeringCatalogRevision: string | null;
}

type BindingRow = {
  version_id: string;
  version_number: number;
  provider: "gemini";
  model_id: string;
  persona_version: string;
  knowledge_version_id: string | null;
  persona_config: Record<string, unknown>;
  intent_catalog_version_id?: string | null;
  intent_catalog_revision?: number | null;
  offering_catalog_version_id?: string | null;
  offering_catalog_revision?: number | null;
};

function binding(agentId: string, row: BindingRow): AgentBinding {
  return {
    agentId,
    versionId: row.version_id,
    versionNumber: row.version_number,
    provider: row.provider,
    modelId: row.model_id,
    personaVersion: row.persona_version,
    knowledgeVersionId: row.knowledge_version_id,
    personaConfig: row.persona_config,
    intentCatalogVersionId: row.intent_catalog_version_id ?? null,
    intentCatalogRevision: row.intent_catalog_revision == null ? null : String(row.intent_catalog_revision),
    offeringCatalogVersionId: row.offering_catalog_version_id ?? null,
    offeringCatalogRevision: row.offering_catalog_revision == null ? null : String(row.offering_catalog_revision),
  };
}

export async function publishedBinding(client: PoolClient, agentId: string): Promise<AgentBinding> {
  const query = await client.query<BindingRow>(
    [
      "SELECT v.id AS version_id, v.version_number, v.provider, v.model_id,",
      "v.persona_version, v.knowledge_version_id, v.persona_config,",
      "ic.id AS intent_catalog_version_id, ic.revision AS intent_catalog_revision,",
      "oc.id AS offering_catalog_version_id, oc.revision AS offering_catalog_revision",
      "FROM agents a JOIN agent_versions v ON v.agent_id=a.id AND v.id=a.active_version_id",
      "LEFT JOIN LATERAL (SELECT id,revision FROM intent_catalog_versions",
      "WHERE agent_id=a.id AND status='published' LIMIT 1) ic ON true",
      "LEFT JOIN LATERAL (SELECT id,revision FROM offering_catalog_versions",
      "WHERE agent_id=a.id AND status='published' LIMIT 1) oc ON true",
      "WHERE a.id=$1 AND a.status='active' AND v.published_at IS NOT NULL",
      "AND v.provider='gemini'",
    ].join(" "),
    [agentId],
  );
  const row = query.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Active published Gemini agent not found");
  return binding(agentId, row);
}

export class AgentRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  /** Unscoped lookup returns only public alias fields, never private configuration. */
  async resolvePublicKey(key: string): Promise<AgentIdentity | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) {
      throw new PersistenceError("INVALID_INPUT", "Invalid agent key");
    }
    try {
      const result = await this.db.pool.query<{
        id: string; agent_key: string; display_name: string; status: AgentIdentity["status"];
      }>("SELECT id, agent_key, display_name, status FROM agents WHERE agent_key=$1", [key]);
      const row = result.rows[0];
      return row ? { id: row.id, key: row.agent_key, displayName: row.display_name, status: row.status } : null;
    } catch (error) { throw dbError(error); }
  }

  async requireActive(agentId: string): Promise<AgentBinding> {
    requireUuid(agentId, "agentId");
    return this.db.withAgent(agentId, client => publishedBinding(client, agentId));
  }

  async getPinnedBinding(agentId: string, versionId: string): Promise<AgentBinding> {
    requireUuid(agentId, "agentId");
    requireUuid(versionId, "versionId");
    return this.db.withAgent(agentId, async client => {
      const result = await client.query<BindingRow>(
        [
          "SELECT id AS version_id,version_number,provider,model_id,",
          "persona_version,knowledge_version_id,persona_config",
          "FROM agent_versions WHERE agent_id=$1 AND id=$2",
          "AND published_at IS NOT NULL AND provider='gemini'",
        ].join(" "),
        [agentId, versionId],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "Published Gemini version not found");
      return binding(agentId, row);
    });
  }

  /** Read immutable ticket-pinned versions only after ticket ownership validation. */
  async getPinnedForTicket(scope: TicketScope, ticketId: string): Promise<AgentBinding> {
    return this.db.withAgent(scope.agentId, async client => {
      const ticket = await authorizedTicket(client, scope, ticketId);
      const result = await client.query<BindingRow>(
        [
          "SELECT v.id AS version_id,v.version_number,v.provider,v.model_id,",
          "v.persona_version,v.knowledge_version_id,v.persona_config,",
          "ic.revision AS intent_catalog_revision,oc.revision AS offering_catalog_revision",
          "FROM agent_versions v",
          "LEFT JOIN intent_catalog_versions ic ON ic.agent_id=v.agent_id",
          "AND ic.id=$3 AND ic.status IN ('published','retired')",
          "LEFT JOIN offering_catalog_versions oc ON oc.agent_id=v.agent_id",
          "AND oc.id=$4 AND oc.status IN ('published','retired')",
          "WHERE v.agent_id=$1 AND v.id=$2 AND v.published_at IS NOT NULL",
          "AND v.provider='gemini'",
        ].join(" "),
        [scope.agentId, ticket["agent_version_id"],
          ticket["intent_catalog_version_id"], ticket["offering_catalog_version_id"]],
      );
      const row = result.rows[0];
      if (!row || (ticket["intent_catalog_version_id"] && row.intent_catalog_revision == null) ||
        (ticket["offering_catalog_version_id"] && row.offering_catalog_revision == null)) {
        throw new PersistenceError("NOT_FOUND", "Ticket-pinned Gemini configuration unavailable");
      }
      return binding(scope.agentId, {
        ...row,
        intent_catalog_version_id: ticket["intent_catalog_version_id"] as string | null,
        offering_catalog_version_id: ticket["offering_catalog_version_id"] as string | null,
      });
    });
  }
}
