/**
 * Executable contract for every catalog-declared POC operation.
 * External Salesforce, PDF and payment actions retain their separately
 * authorized Node APIs. Other catalog actions record a durable ticket service
 * request ONLY; they do not invent bank, visa or government integrations.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { authorizedTicket, workerTicketScope, type TicketScope } from "../repositories/types.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { appendEventTx } from "../repositories/events.js";
import { identityDocumentReadinessTx, assertIdentityDocumentsReadyTx } from "./purchase-operations.js";

export const SERVICE_REQUEST_CONSENT =
  "I ask ANCFZ to record this POC service request using the information I provided in this ticket. I understand this does not submit an application to a bank, government body or external partner.";

export const SERVICE_ACTION_LABELS={
  create_enquiry:"Service enquiry",
  create_renewal_request:"Licence renewal request",
  create_amendment_request:"Licence amendment request",
  create_visa_enquiry:"Visa service enquiry",
  create_referral:"Partner referral request",
  request_specialist_review:"Specialist review request",
  create_support_request:"Customer support request",
} as const;
export type ServiceAction=keyof typeof SERVICE_ACTION_LABELS;
export const EXTERNAL_ACTIONS=["create_lead","generate_quote","purchase_quotation"] as const;
export const SUPPORTED_CATALOG_ACTIONS=new Set<string>([
  ...Object.keys(SERVICE_ACTION_LABELS),...EXTERNAL_ACTIONS,
]);

/** The published intent array may contain duplicate action names.
 * Only expose each action once to the model and customer UI.
 */
export function uniqueAllowedActions(actions: readonly string[]): string[] {
  return [...new Set(actions)];
}
export function isServiceAction(action:string):action is ServiceAction {
  return Object.prototype.hasOwnProperty.call(SERVICE_ACTION_LABELS,action);
}
export function classifyAction(action:string):"ticket_request"|"salesforce_lead"|"quotation"|"purchase"|null {
  if(isServiceAction(action))return "ticket_request";
  if(action==="create_lead")return "salesforce_lead";
  if(action==="generate_quote")return "quotation";
  if(action==="purchase_quotation")return "purchase";
  return null;
}

type IntentRow={id:string;intent_key:string;name:string;allowed_actions:string[]};
type FactRow={fact_key:string;value:unknown;verification_status:string;source_message_id:string};
type RequirementRow={requirement_key:string;label:string;required_for:string[]};
type RequestRow={id:string;action_key:string;status:string;request_id:string;created_at:Date;intent_id:string};
function availableValue(v:unknown):boolean {
  if(typeof v==="string")return v.trim().length>0;
  if(typeof v==="number")return Number.isFinite(v);
  if(typeof v==="boolean")return true;
  return false;
}
function toView(row:RequestRow){
  return {id:row.id,actionKey:row.action_key,status:row.status,
    createdAt:row.created_at.toISOString()};
}
async function activeIntent(client:PoolClient,agentId:string,ticketId:string):Promise<IntentRow|null>{
  const found=await client.query<IntentRow>(
    `SELECT i.id,i.intent_key,i.name,i.allowed_actions
      FROM tickets t
      JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id
        AND ti.status='active'
      JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
        AND i.catalog_version_id=t.intent_catalog_version_id
      WHERE t.agent_id=$1 AND t.id=$2 AND t.status<>'closed'
      LIMIT 1`,[agentId,ticketId],
  );
  return found.rows[0]??null;
}
async function actionRequirements(client:PoolClient,agentId:string,ticketId:string,intentId:string,
  action:string,preloaded?:{requirements:RequirementRow[];facts:FactRow[]}){
  const reqs=preloaded
    ?preloaded.requirements.filter(r=>r.required_for.includes(action))
    :(await client.query<RequirementRow>(
      `SELECT requirement_key,label,required_for FROM intent_requirements
        WHERE agent_id=$1 AND intent_id=$2 AND $3=ANY(required_for)
        ORDER BY requirement_key`,[agentId,intentId,action],
    )).rows;
  const facts=preloaded?.facts??(await client.query<FactRow>(
    `SELECT fact_key,value,verification_status,source_message_id
      FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2`,[agentId,ticketId],
  )).rows;
  const byKey=new Map(facts.map(f=>[f.fact_key,f]));
  const requirements=reqs.map(r=>{
    const fact=byKey.get(r.requirement_key);
    return {key:r.requirement_key,label:r.label,
      present:fact!==undefined && fact.verification_status!=="disputed"&&availableValue(fact.value)};
  });
  return {requirements,missing:requirements.filter(x=>!x.present).map(x=>x.key),
    sourceFacts:facts};
}
/**
 * Enforce the same catalog prerequisites on direct HTTP calls that the
 * intent-action panel displays. The browser and model cannot bypass them.
 * Identity documents remain separately gated by purchase/service actions.
 */
export async function assertCatalogActionRequirementsTx(
  client:PoolClient,agentId:string,ticketId:string,action:string,
):Promise<void>{
  const intent=await activeIntent(client,agentId,ticketId);
  if(!intent||!intent.allowed_actions.includes(action))
    throw new PersistenceError("CONFLICT","The selected intent does not authorize this action");
  const {missing}=await actionRequirements(client,agentId,ticketId,intent.id,action);
  if(missing.length)
    throw new PersistenceError("CONFLICT",
      "Collect the required "+action+" information in the ticket before proceeding");
}
export class IntentActionOperations {
  constructor(private readonly db:PersistenceDatabase){}
  async catalog(scope:TicketScope,ticketId:string){
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const intent=await activeIntent(client,scope.agentId,ticketId);
      if(!intent)return {intentKey:null,actions:[],unknownActions:[]};
      const requests=await client.query<RequestRow>(
        `SELECT id,intent_id,action_key,status,request_id,created_at
          FROM ticket_service_requests
          WHERE agent_id=$1 AND ticket_id=$2 AND intent_id=$3`,
        [scope.agentId,ticketId,intent.id],
      );
      const byAction=new Map(requests.rows.map(x=>[x.action_key,x]));
      const identity=await identityDocumentReadinessTx(client,scope.agentId,ticketId,intent.id);
      // Load ticket facts and catalog requirements once, not once per action.
      const allRequirements=await client.query<RequirementRow>(
        `SELECT requirement_key,label,required_for FROM intent_requirements
          WHERE agent_id=$1 AND intent_id=$2 ORDER BY requirement_key`,
        [scope.agentId,intent.id],
      );
      const allFacts=await client.query<FactRow>(
        `SELECT fact_key,value,verification_status,source_message_id
          FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2`,
        [scope.agentId,ticketId],
      );
      const preloaded={requirements:allRequirements.rows,facts:allFacts.rows};
      const result=[];
      const allowedActions=uniqueAllowedActions(intent.allowed_actions);
      for(const action of allowedActions){
        const kind=classifyAction(action);
        if(!kind)continue;
        const facts=await actionRequirements(client,scope.agentId,ticketId,intent.id,action,preloaded);
        const missing=isServiceAction(action)
          ? [...facts.missing,...identity.missing]:facts.missing;
        result.push({actionKey:action,label:isServiceAction(action)?
          SERVICE_ACTION_LABELS[action]:action.replaceAll("_"," "),
          kind,requirements:facts.requirements,missing,
          ready:missing.length===0,
          request:byAction.has(action)?toView(byAction.get(action) as RequestRow):null});
      }
      return {intentKey:intent.intent_key,intentName:intent.name,
        actions:result,unknownActions:allowedActions.filter(a=>!classifyAction(a))};
    });
  }
  async submit(scope:TicketScope,ticketId:string,action:string,raw:unknown){
    requireUuid(ticketId,"ticketId");
    if(!isServiceAction(action))throw new PersistenceError("INVALID_INPUT","Unknown service action");
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Service-request consent is required");
    const input=raw as Record<string,unknown>;
    if(Object.keys(input).some(k=>!["requestId","consent","consentText"].includes(k))||
       typeof input.requestId!=="string"||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)||
       input.consent!==true||input.consentText!==SERVICE_REQUEST_CONSENT)
      throw new PersistenceError("INVALID_INPUT","Exact service-request consent is required");

    const normalizedRequestId=String(input.requestId).toLowerCase();
    const outcome=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const intent=await activeIntent(client,scope.agentId,ticketId);
      if(!intent||!intent.allowed_actions.includes(action))
        throw new PersistenceError("CONFLICT","The selected intent does not allow this request");
      await assertIdentityDocumentsReadyTx(client,scope.agentId,ticketId,intent.id);
      const {requirements,missing,sourceFacts}=await actionRequirements(
        client,scope.agentId,ticketId,intent.id,action);
      if(missing.length)
        throw new PersistenceError("CONFLICT","Provide the missing required information before this action");
      const saved=await client.query<RequestRow>(
        `SELECT id,intent_id,action_key,status,request_id,created_at
          FROM ticket_service_requests
          WHERE agent_id=$1 AND ticket_id=$2 AND intent_id=$3 AND action_key=$4`,
        [scope.agentId,ticketId,intent.id,action],
      );
      if(saved.rows[0]){
        if(saved.rows[0].request_id!==normalizedRequestId)
          throw new PersistenceError("CONFLICT","A service request already exists for this intent/action");
        return {request:toView(saved.rows[0]),duplicated:true};
      }
      const requestId=randomUUID();
      // Facts have customer-message provenance. Do not include raw passport
      // bytes or OCR output, and do not dispatch any unknown third party.
      const relevant=new Set(requirements.map(r=>r.key));
      const facts=Object.fromEntries(sourceFacts.filter(f=>
        relevant.has(f.fact_key)&&f.verification_status!=="disputed"&&availableValue(f.value)
      ).map(f=>[f.fact_key,{value:f.value,sourceMessageId:f.source_message_id}]));
      const inserted=await client.query<RequestRow>(
        `INSERT INTO ticket_service_requests(
          id,agent_id,ticket_id,intent_id,action_key,request_id,
          fact_snapshot,consent_text)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         RETURNING id,intent_id,action_key,status,request_id,created_at`,
        [requestId,scope.agentId,ticketId,intent.id,action,
          normalizedRequestId,JSON.stringify(facts),SERVICE_REQUEST_CONSENT],
      );
      await appendEventTx(client,scope.agentId,ticketId,"ticket.service_request.recorded",{
        serviceRequestId:requestId,intentKey:intent.intent_key,actionKey:action,
        status:"awaiting_staff_review",externalDispatch:false});
      return {request:toView(inserted.rows[0]),duplicated:false};
    });
    try {
      await new TicketMessageRepository(this.db).createAssistantMessage(
        workerTicketScope(scope.agentId,ticketId),ticketId,outcome.request.id,
        "Sara: Your "+SERVICE_ACTION_LABELS[action].toLowerCase()+
        " is recorded in this ticket for ANCFZ staff review. "+
        "This POC has not submitted anything to an external authority or partner.",[]);
    } catch {/* Request is already durably recorded; chat can be refreshed. */}
    return outcome;
  }
}
