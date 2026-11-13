import { PersistenceDatabase, PersistenceError, requireBounded } from "../database/pool.js";
import { authorizedTicket, assertAgentActive, asIso, type TicketScope } from "./types.js";

export interface ProviderConversation {
  provider: string;
  externalConversationId: string;
  lastResponseId: string | null;
  agentVersionId: string;
  updatedAt: string;
}

interface ModelSessionRow {
  provider: string;
  external_conversation_id: string;
  last_response_id: string | null;
  agent_version_id: string;
  updated_at: Date;
}

function mapRow(row: ModelSessionRow): ProviderConversation {
  return {
    provider: row.provider,
    externalConversationId: row.external_conversation_id,
    lastResponseId: row.last_response_id,
    agentVersionId: row.agent_version_id,
    updatedAt: asIso(row.updated_at) as string,
  };
}

function requireProvider(provider: string): void {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(provider)) {
    throw new PersistenceError("INVALID_INPUT", "Invalid provider");
  }
}

// Stores only opaque external identifiers, not Foundry credentials or model
// orchestration state. Application owner controls SDK requests and turn leases.
export class ConversationContinuityRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async get(scope: TicketScope, ticketId: string, provider: string): Promise<ProviderConversation | null> {
    requireProvider(provider);
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const result = await client.query<ModelSessionRow>(
        "SELECT provider, external_conversation_id, last_response_id, agent_version_id, updated_at FROM ticket_model_sessions WHERE agent_id = $1 AND ticket_id = $2 AND provider = $3",
        [scope.agentId, ticketId, provider],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async bind(
    scope: TicketScope, ticketId: string, provider: string, externalConversationId: string,
  ): Promise<ProviderConversation> {
    requireProvider(provider);
    requireBounded(externalConversationId, "externalConversationId", 1024);
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId, true);
      await assertAgentActive(client, scope.agentId);
      if (ticket["status"] === "closed") throw new PersistenceError("CONFLICT", "Ticket is closed");
      const existing = await client.query<ModelSessionRow>(
        "SELECT provider, external_conversation_id, last_response_id, agent_version_id, updated_at FROM ticket_model_sessions WHERE agent_id = $1 AND ticket_id = $2 AND provider = $3",
        [scope.agentId, ticketId, provider],
      );
      const current = existing.rows[0];
      if (current) {
        if (current.external_conversation_id !== externalConversationId) {
          throw new PersistenceError("CONFLICT", "Ticket already bound to a different provider conversation");
        }
        return mapRow(current);
      }
      const saved = await client.query<ModelSessionRow>(
        [
          "INSERT INTO ticket_model_sessions (agent_id, ticket_id, agent_version_id, provider, external_conversation_id)",
          "VALUES ($1, $2, $3, $4, $5)",
          "RETURNING provider, external_conversation_id, last_response_id, agent_version_id, updated_at",
        ].join(" "),
        [scope.agentId, ticketId, ticket["agent_version_id"], provider, externalConversationId],
      );
      const row = saved.rows[0];
      if (!row) throw new PersistenceError("DATABASE_ERROR", "Conversation binding returned no row");
      return mapRow(row);
    });
  }

  async advanceCursor(
    scope: TicketScope, ticketId: string, provider: string,
    expectedPreviousResponseId: string | null, newResponseId: string,
  ): Promise<ProviderConversation> {
    requireProvider(provider);
    requireBounded(newResponseId, "newResponseId", 1024);
    if (expectedPreviousResponseId !== null) {
      requireBounded(expectedPreviousResponseId, "expectedPreviousResponseId", 1024);
    }
    return this.db.withAgent(scope.agentId, async (client) => {
      await authorizedTicket(client, scope, ticketId);
      const saved = await client.query<ModelSessionRow>(
        [
          "UPDATE ticket_model_sessions SET last_response_id = $5, updated_at = now()",
          "WHERE agent_id = $1 AND ticket_id = $2 AND provider = $3",
          "AND last_response_id IS NOT DISTINCT FROM $4",
          "RETURNING provider, external_conversation_id, last_response_id, agent_version_id, updated_at",
        ].join(" "),
        [scope.agentId, ticketId, provider, expectedPreviousResponseId, newResponseId],
      );
      const row = saved.rows[0];
      if (!row) throw new PersistenceError("CONFLICT", "Provider cursor changed or binding is missing");
      return mapRow(row);
    });
  }
}
