export {
  PersistenceDatabase, PersistenceError, requireUuid, dbError,
} from "../database/pool.js";
export { AgentRepository } from "./agent.js";
export { GuestSessionRepository, TicketRepository } from "./tickets.js";
export { TicketMessageRepository } from "./messages.js";
export { TicketEventRepository } from "./events.js";
export { ConversationContextRepository } from "./context.js";
export { scopedIntentToolRepositories } from "./intent-adapter.js";
export type { AgentIdentity, AgentBinding } from "./agent.js";
export type { TicketRecord, TicketScope, TicketOwner, MessageRecord, SourceReference, EventRecord } from "./types.js";
export type { StoredFact, ConversationContext, FactValue, Verification } from "./context.js";
