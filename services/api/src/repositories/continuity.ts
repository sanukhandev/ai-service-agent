import { PersistenceDatabase, PersistenceError, requireBounded } from "../database/pool.js";
import { authorizedTicket, asIso, type TicketScope } from "./types.js";

export interface ProviderConversation {
  provider: string;
  lastResponseId: string | null;
  agentVersionId: string;
  updatedAt: string;
}

function providerName(provider: string): void {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(provider)) {
    throw new PersistenceError("INVALID_INPUT", "Invalid provider");
  }
}

/** Foundry Responses continuation: only actual response IDs are persisted.
 * P3 TurnQueue.complete atomically advances this cursor with the assistant message.
 */
export class ConversationContinuityRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async get(scope: TicketScope, ticketId: string, provider: string): Promise<ProviderConversation | null> {
    providerName(provider);
    return this.db.withAgent(scope.agentId, async client => {
      await authorizedTicket(client,scope,ticketId);
      const result=await client.query<{
        provider:string;last_response_id:string|null;agent_version_id:string;updated_at:Date;
      }>(
        "SELECT provider,last_response_id,agent_version_id,updated_at FROM ticket_model_sessions WHERE agent_id=$1 AND ticket_id=$2 AND provider=$3",
        [scope.agentId,ticketId,provider],
      );
      const row=result.rows[0];
      return row ? {
        provider:row.provider,lastResponseId:row.last_response_id,
        agentVersionId:row.agent_version_id,updatedAt:asIso(row.updated_at) as string,
      } : null;
    });
  }

  async advanceCursor(
    scope: TicketScope,ticketId:string,provider:string,
    expectedPreviousResponseId:string|null,newResponseId:string,
  ):Promise<ProviderConversation> {
    providerName(provider);
    requireBounded(newResponseId,"newResponseId",1024);
    if(expectedPreviousResponseId!==null) requireBounded(expectedPreviousResponseId,"expectedPreviousResponseId",1024);
    return this.db.withAgent(scope.agentId,async client=>{
      const ticket=await authorizedTicket(client,scope,ticketId,true);
      const updated=await client.query<{
        provider:string;last_response_id:string|null;agent_version_id:string;updated_at:Date;
      }>(
        [
          "INSERT INTO ticket_model_sessions(agent_id,ticket_id,agent_version_id,provider,last_response_id)",
          "VALUES($1,$2,$3,$4,$6) ON CONFLICT(agent_id,ticket_id,provider)",
          "DO UPDATE SET last_response_id=EXCLUDED.last_response_id,updated_at=now()",
          "WHERE ticket_model_sessions.last_response_id IS NOT DISTINCT FROM $5",
          "RETURNING provider,last_response_id,agent_version_id,updated_at",
        ].join(" "),
        [scope.agentId,ticketId,ticket["agent_version_id"],provider,expectedPreviousResponseId,newResponseId],
      );
      const row=updated.rows[0];
      if(!row) throw new PersistenceError("CONFLICT","Provider response cursor changed");
      return {
        provider:row.provider,lastResponseId:row.last_response_id,
        agentVersionId:row.agent_version_id,updatedAt:asIso(row.updated_at) as string,
      };
    });
  }
}
