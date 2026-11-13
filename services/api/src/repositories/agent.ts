import type { PoolClient } from "pg";
import { PersistenceDatabase, PersistenceError, dbError, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "./types.js";

export interface AgentIdentity {
  id: string;
  key: string;
  displayName: string;
  status: "draft" | "active" | "paused" | "archived";
}

export interface AgentBinding {
  agentId: string;
  versionId: string;
  versionNumber: number;
  foundryProjectEndpoint: string;
  foundryAgentName: string;
  foundryAgentVersion: string;
  knowledgeBindingRef: string | null;
  personaConfig: Record<string, unknown>;
  intentCatalogVersionId: string | null;
  intentCatalogRevision: string | null;
  offeringCatalogVersionId: string | null;
  offeringCatalogRevision: string | null;
}

export async function publishedBinding(client: PoolClient, agentId: string): Promise<AgentBinding> {
  const query = await client.query<{
    version_id: string; version_number: number; foundry_project_endpoint: string;
    foundry_agent_name: string; foundry_agent_version: string; knowledge_binding_ref: string | null;
    persona_config: Record<string, unknown>; intent_catalog_version_id: string | null;
    intent_catalog_revision: number | null; offering_catalog_version_id: string | null;
    offering_catalog_revision: number | null;
  }>(
    [
      "SELECT v.id AS version_id, v.version_number, v.foundry_project_endpoint,",
      "v.foundry_agent_name, v.foundry_agent_version, v.knowledge_binding_ref, v.persona_config,",
      "ic.id AS intent_catalog_version_id, ic.revision AS intent_catalog_revision,",
      "oc.id AS offering_catalog_version_id, oc.revision AS offering_catalog_revision",
      "FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.id = a.active_version_id",
      "LEFT JOIN LATERAL (SELECT id, revision FROM intent_catalog_versions",
      "WHERE agent_id = a.id AND status = 'published' LIMIT 1) ic ON true",
      "LEFT JOIN LATERAL (SELECT id, revision FROM offering_catalog_versions",
      "WHERE agent_id = a.id AND status = 'published' LIMIT 1) oc ON true",
      "WHERE a.id = $1 AND a.status = 'active' AND v.published_at IS NOT NULL",
    ].join(" "),
    [agentId],
  );
  const row = query.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Agent inactive or not published");
  return {
    agentId, versionId: row.version_id, versionNumber: row.version_number,
    foundryProjectEndpoint: row.foundry_project_endpoint,
    foundryAgentName: row.foundry_agent_name,
    foundryAgentVersion: row.foundry_agent_version,
    knowledgeBindingRef: row.knowledge_binding_ref,
    personaConfig: row.persona_config,
    intentCatalogVersionId: row.intent_catalog_version_id,
    intentCatalogRevision: row.intent_catalog_revision === null ? null : String(row.intent_catalog_revision),
    offeringCatalogVersionId: row.offering_catalog_version_id,
    offeringCatalogRevision: row.offering_catalog_revision === null ? null : String(row.offering_catalog_revision),
  };
}

export class AgentRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  // Unscoped read is ONLY for the public alias mapping on agents.
  // All private configuration reads are agent-scoped under RLS.
  async resolvePublicKey(key: string): Promise<AgentIdentity | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) {
      throw new PersistenceError("INVALID_INPUT", "Invalid agent key");
    }
    try {
      const result = await this.db.pool.query<{
        id: string; agent_key: string; display_name: string; status: AgentIdentity["status"];
      }>(
        "SELECT id, agent_key, display_name, status FROM agents WHERE agent_key = $1",
        [key],
      );
      const row = result.rows[0];
      return row ? { id: row.id, key: row.agent_key, displayName: row.display_name, status: row.status } : null;
    } catch (error) { throw dbError(error); }
  }

  async requireActive(agentId: string): Promise<AgentBinding> {
    requireUuid(agentId, "agentId");
    return this.db.withAgent(agentId, async (client) => publishedBinding(client, agentId));
  }

  async getPinnedBinding(agentId: string, versionId: string): Promise<AgentBinding> {
    requireUuid(versionId, "versionId");
    return this.db.withAgent(agentId, async (client) => {
      const result = await client.query<{
        id: string; version_number: number; foundry_project_endpoint: string;
        foundry_agent_name: string; foundry_agent_version: string;
        knowledge_binding_ref: string | null; persona_config: Record<string, unknown>;
      }>(
        "SELECT id, version_number, foundry_project_endpoint, foundry_agent_name, foundry_agent_version, knowledge_binding_ref, persona_config FROM agent_versions WHERE agent_id = $1 AND id = $2 AND published_at IS NOT NULL",
        [agentId, versionId],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "Pinned agent version not found");
      return {
        agentId, versionId: row.id, versionNumber: row.version_number,
        foundryProjectEndpoint: row.foundry_project_endpoint,
        foundryAgentName: row.foundry_agent_name,
        foundryAgentVersion: row.foundry_agent_version,
        knowledgeBindingRef: row.knowledge_binding_ref, personaConfig: row.persona_config,
        intentCatalogVersionId: null, intentCatalogRevision: null,
        offeringCatalogVersionId: null, offeringCatalogRevision: null,
      };
    });
  }

  // The ticket is authorized first, then its immutable version/catalog foreign
  // keys are read server-side. The caller cannot choose unrelated revisions.
  async getPinnedForTicket(scope: TicketScope, ticketId: string): Promise<AgentBinding> {
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId);
      const result = await client.query<{
        id: string; version_number: number; foundry_project_endpoint: string;
        foundry_agent_name: string; foundry_agent_version: string;
        knowledge_binding_ref: string | null; persona_config: Record<string, unknown>;
        ic_revision: number | null; oc_revision: number | null;
      }>(
        [
          "SELECT v.id, v.version_number, v.foundry_project_endpoint, v.foundry_agent_name,",
          "v.foundry_agent_version, v.knowledge_binding_ref, v.persona_config,",
          "ic.revision AS ic_revision, oc.revision AS oc_revision",
          "FROM agent_versions v",
          "LEFT JOIN intent_catalog_versions ic ON ic.agent_id = v.agent_id",
          "AND ic.id = $3 AND ic.status IN ('published', 'retired')",
          "LEFT JOIN offering_catalog_versions oc ON oc.agent_id = v.agent_id",
          "AND oc.id = $4 AND oc.status IN ('published', 'retired')",
          "WHERE v.agent_id = $1 AND v.id = $2 AND v.published_at IS NOT NULL",
        ].join(" "),
        [scope.agentId, ticket["agent_version_id"],
          ticket["intent_catalog_version_id"], ticket["offering_catalog_version_id"]],
      );
      const row = result.rows[0];
      if (!row || (ticket["intent_catalog_version_id"] && row.ic_revision === null) ||
        (ticket["offering_catalog_version_id"] && row.oc_revision === null)) {
        throw new PersistenceError("NOT_FOUND", "Pinned configuration unavailable");
      }
      return {
        agentId: scope.agentId, versionId: row.id, versionNumber: row.version_number,
        foundryProjectEndpoint: row.foundry_project_endpoint,
        foundryAgentName: row.foundry_agent_name,
        foundryAgentVersion: row.foundry_agent_version,
        knowledgeBindingRef: row.knowledge_binding_ref,
        personaConfig: row.persona_config,
        intentCatalogVersionId: ticket["intent_catalog_version_id"] as string | null,
        intentCatalogRevision: row.ic_revision === null ? null : String(row.ic_revision),
        offeringCatalogVersionId: ticket["offering_catalog_version_id"] as string | null,
        offeringCatalogRevision: row.oc_revision === null ? null : String(row.oc_revision),
      };
    });
  }

}
