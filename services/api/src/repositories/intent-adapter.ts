import type {
  CatalogRepository, IntentEntry, OfferingEntry,
  TicketFactRepository, TicketIntentRepository, TicketFact,
} from "../agent/intent-tools.js";
import { AgentScopedDatabase, PgCatalogRepository } from "../agent/postgres-repositories.js";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { ConversationContextRepository, type FactValue } from "./context.js";
import type { TicketScope } from "./types.js";

// Construct this adapter per authorized ticket request, not as a singleton with
// a mutable global current user. It implements existing P3 tool contracts
// without changing the Track E source files.
export function scopedIntentToolRepositories(
  db: PersistenceDatabase,
  scope: TicketScope,
  ticketId: string,
): {
  catalog: CatalogRepository;
  facts: TicketFactRepository;
  ticketIntents: TicketIntentRepository;
} {
  const legacyCatalog = new PgCatalogRepository(new AgentScopedDatabase(db.pool));
  const context = new ConversationContextRepository(db);

  function check(agentId: string, requestedTicketId?: string): void {
    if (agentId !== scope.agentId || (requestedTicketId && requestedTicketId !== ticketId)) {
      throw new PersistenceError("NOT_FOUND", "Ticket not found");
    }
  }

  const catalog: CatalogRepository = {
    async listIntents(agentId: string, catalogVersion: string): Promise<IntentEntry[]> {
      check(agentId);
      const pinned = await context.read(scope, ticketId);
      if (catalogVersion !== pinned.intentCatalogRevision) {
        throw new PersistenceError("NOT_FOUND", "Intent catalog revision is not pinned to the ticket");
      }
      return legacyCatalog.listIntents(agentId, catalogVersion);
    },
    async listOfferings(
      agentId: string, catalogVersion: string, intentKey?: string,
    ): Promise<OfferingEntry[]> {
      check(agentId);
      const pinned = await context.read(scope, ticketId);
      if (catalogVersion !== pinned.offeringCatalogRevision) {
        throw new PersistenceError("NOT_FOUND", "Offering catalog revision is not pinned to the ticket");
      }
      return legacyCatalog.listOfferings(agentId, catalogVersion, intentKey);
    },
  };
  const facts: TicketFactRepository = {
    async listFacts(agentId: string, requestedTicketId: string): Promise<TicketFact[]> {
      check(agentId, requestedTicketId);
      const found = await context.read(scope, ticketId);
      return found.facts.map((fact) => ({
        key: fact.key, value: fact.value, verification: fact.verification,
        sourceMessageId: fact.sourceMessageId, updatedAt: fact.updatedAt,
      }));
    },
    async recordCustomerFacts(
      agentId: string,
      requestedTicketId: string,
      sourceMessageId: string,
      updates: ReadonlyArray<{ key: string; value: FactValue }>,
    ): Promise<TicketFact[]> {
      check(agentId, requestedTicketId);
      return context.recordCustomerFacts(scope, ticketId, sourceMessageId, updates);
    },
  };
  const ticketIntents: TicketIntentRepository = {
    async selectIntent(
      agentId: string, requestedTicketId: string,
      catalogVersion: string, intentKey: string,
    ): Promise<{ intentKey: string; status: string }> {
      check(agentId, requestedTicketId);
      const pinned = await context.read(scope, ticketId);
      if (catalogVersion !== pinned.intentCatalogRevision) {
        throw new PersistenceError("NOT_FOUND", "Intent catalog revision is not pinned to the ticket");
      }
      await context.selectIntent(scope, ticketId, intentKey);
      return { intentKey, status: "active" };
    },
  };
  return { catalog, facts, ticketIntents };
}
