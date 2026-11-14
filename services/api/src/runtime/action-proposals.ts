/** Model-visible operation preflight and inert proposal. External effects are impossible here. */
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "../repositories/types.js";
import { appendEventTx } from "../repositories/events.js";
import { AgentToolRegistry, type ToolHandler } from "../agent/tool-registry.js";
import { IntentActionOperations } from "./intent-action-operations.js";

function textArg(value:unknown,key:string):string {
  if(typeof value!=="string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value))
    throw new PersistenceError("INVALID_INPUT","Invalid "+key);
  return value;
}
export class ActionProposalOperations {
  constructor(private readonly db:PersistenceDatabase){}
  async preflight(scope:TicketScope,ticketId:string,intentKey?:string,actionKey?:string){
    requireUuid(ticketId,"ticketId");
    const catalog=await new IntentActionOperations(this.db).catalog(scope,ticketId);
    if(!catalog.intentKey || (intentKey&&catalog.intentKey!==intentKey))
      return {status:"select_intent_first",intentKey:catalog.intentKey,actions:[]};
    const actions=catalog.actions
      .filter(item=>!actionKey||item.actionKey===actionKey)
      .map(item=>({actionKey:item.actionKey,label:item.label,kind:item.kind,
        ready:item.ready,missing:item.missing,
        requestStatus:item.request?.status??null}));
    return {status:actions.length?"ok":"action_not_allowed",
      intentKey:catalog.intentKey,actions,
      requiresCustomerAuthorization:true,executed:false};
  }
  async propose(scope:TicketScope,ticketId:string,sourceMessageId:string,intentKey:string,actionKey:string){
    requireUuid(sourceMessageId,"sourceMessageId");
    const prior=await this.preflight(scope,ticketId,intentKey,actionKey);
    const selected=prior.actions[0];
    if(prior.status!=="ok"||!selected)
      return {status:"not_available",reason:prior.status,executed:false};
    if(!selected.ready)
      return {status:"missing_requirements",intentKey,actionKey,missing:selected.missing,executed:false};
    if(selected.requestStatus)
      return {status:"already_recorded",intentKey,actionKey,requestStatus:selected.requestStatus,executed:false};
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      // Re-check the pinned, active intent and exact customer-message provenance
      // under one ticket row lock. A proposal does not grant consent.
      const result=await client.query<{id:string}>(`
        SELECT i.id FROM tickets t
        JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active'
        JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
          AND i.catalog_version_id=t.intent_catalog_version_id
        JOIN ticket_messages m ON m.agent_id=t.agent_id AND m.ticket_id=t.id
          AND m.id=$4 AND m.role='customer'
        JOIN ai_conversation_sessions s ON s.agent_id=t.agent_id AND s.ticket_id=t.id
          AND s.status='active' AND s.expires_at>now()
        WHERE t.agent_id=$1 AND t.id=$2 AND i.intent_key=$3 AND t.status<>'closed'
          AND $5=ANY(i.allowed_actions) LIMIT 1`,[
        scope.agentId,ticketId,intentKey,sourceMessageId,actionKey,
      ]);
      const intentId=result.rows[0]?.id;
      if(!intentId)throw new PersistenceError("CONFLICT","No authorized active intent or message");
      const inserted=await client.query<{id:string}>(`
        INSERT INTO ticket_action_proposals(agent_id,ticket_id,intent_id,
          source_message_id,action_key)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(agent_id,ticket_id,source_message_id,action_key) DO NOTHING
        RETURNING id`,[scope.agentId,ticketId,intentId,sourceMessageId,actionKey]);
      let id=inserted.rows[0]?.id;
      if(!id){
        const existing=await client.query<{id:string}>(`
          SELECT id FROM ticket_action_proposals WHERE agent_id=$1 AND ticket_id=$2
          AND source_message_id=$3 AND action_key=$4`,
          [scope.agentId,ticketId,sourceMessageId,actionKey]);
        id=existing.rows[0]?.id;
      }
      if(!id)throw new PersistenceError("DATABASE_ERROR","Proposal not recorded");
      if(inserted.rows.length){
        await appendEventTx(client,scope.agentId,ticketId,"operation.proposed",{
          proposalId:id,intentKey,actionKey,requiresCustomerAuthorization:true,
          externalDispatch:false,
        });
      }
      return {status:"awaiting_customer_authorization",proposalId:id,
        intentKey,actionKey,label:selected.label,
        nextStep:"Customer must authorize the action in the ticket UI",
        requiresCustomerAuthorization:true,executed:false};
    });
  }
}
export function registerOperationTools(
  registry:AgentToolRegistry,operations:ActionProposalOperations,scope:TicketScope,
):void {
  const parameters=(properties:Record<string,unknown>,required:string[]=[])=>({
    type:"object",properties,required,additionalProperties:false,
  });
  const key={type:"string",maxLength:128,pattern:"^[a-z][a-z0-9_]{0,127}$"};
  const handlers:ToolHandler[]=[
    {
      name:"preflight_operation",
      description:"Check currently selected intent's eligible actions and missing requirements. No workflow executes.",
      parameters:parameters({intentKey:key,actionKey:key}),
      async execute(ctx,args){
        return operations.preflight(scope,ctx.ticketId,
          args["intentKey"]===undefined?undefined:textArg(args["intentKey"],"intentKey"),
          args["actionKey"]===undefined?undefined:textArg(args["actionKey"],"actionKey"));
      },
    },
    {
      name:"propose_operation",
      description:"Record an inert, non-executing proposal ONLY after the customer requests an eligible action. Explicit customer UI authorization is still required. This tool never calls n8n, CRM or payment providers.",
      parameters:parameters({intentKey:key,actionKey:key},["intentKey","actionKey"]),
      async execute(ctx,args){
        return operations.propose(scope,ctx.ticketId,ctx.sourceCustomerMessageId,
          textArg(args["intentKey"],"intentKey"),textArg(args["actionKey"],"actionKey"));
      },
    },
  ];
  for(const handler of handlers)registry.register(handler);
}
