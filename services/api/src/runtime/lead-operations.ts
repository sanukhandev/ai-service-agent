/**
 * P4 first authorized operation: customer-approved ANCFZ Salesforce lead.
 * Never a model function. Node checks guest ownership, active intent,
 * explicit form consent, idempotency and private n8n dispatch.
 */
import { createHash } from "node:crypto";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "../repositories/types.js";
import { appendEventTx } from "../repositories/events.js";

export interface LeadFields {
  name: string;
  company: string;
  phone: string;
  email: string;
  description: string;
}

export interface LeadOperationView {
  id: string;
  operation: "ancfz_salesforce_lead";
  state: string;
  providerReference: string | null;
  updatedAt: string;
}

const AUTHORIZATION_TEXT = "I authorize ANCFZ to send my contact details to Salesforce to process this enquiry.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const leadIdPattern = /^00Q(?:[A-Za-z0-9]{12}|[A-Za-z0-9]{15})$/;
const address = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const phoneFormat = /^\+?[0-9 ()-]{7,40}$/;

function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new PersistenceError("INVALID_INPUT", "Invalid " + label);
  }
  return value.trim();
}

export function leadDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANCFZ_LEAD_DISPATCH_ENABLED === "true" &&
    typeof env.ANCFZ_N8N_WEBHOOK_SECRET === "string" &&
    env.ANCFZ_N8N_WEBHOOK_SECRET.length >= 32;
}

export function parseAuthorizedLead(raw: unknown): { requestId: string; lead: LeadFields; digest: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PersistenceError("INVALID_INPUT","Invalid lead form");
  const body = raw as Record<string, unknown>;
  const allowed = new Set(["requestId","name","company","phone","email","description","consent","consentText"]);
  if (Object.keys(body).some(k => !allowed.has(k)) ||
      body.consent !== true || body.consentText !== AUTHORIZATION_TEXT) {
    throw new PersistenceError("INVALID_INPUT","Explicit Salesforce contact-sharing consent is required");
  }
  if (typeof body.requestId !== "string" || !uuid.test(body.requestId)) {
    throw new PersistenceError("INVALID_INPUT","Invalid requestId");
  }
  const lead = {
    name:field(body.name,"name",120),
    company:field(body.company,"company",255),
    phone:field(body.phone,"phone",40),
    email:field(body.email,"email",254).toLowerCase(),
    description:field(body.description,"description",4000),
  };
  if (!address.test(lead.email) || !phoneFormat.test(lead.phone)) {
    throw new PersistenceError("INVALID_INPUT","Invalid email or phone");
  }
  const digest = createHash("sha256").update(JSON.stringify(lead)).digest("hex");
  return {requestId: body.requestId.toLowerCase(), lead, digest};
}

export class LeadOperations {
  constructor(private readonly db: PersistenceDatabase) {}

  async submit(scope: TicketScope, ticketId: string, input: unknown): Promise<{ operation: LeadOperationView; duplicated: boolean }> {
    requireUuid(ticketId,"ticketId");
    const {requestId,lead,digest} = parseAuthorizedLead(input);
    if (process.env.APP_ENV === "production" &&
        !process.env.PUBLIC_BASE_URL?.startsWith("https://")) {
      throw new PersistenceError("NOT_CONFIGURED","HTTPS is required for customer contact sharing");
    }
    if (!leadDispatchEnabled()) throw new PersistenceError("NOT_CONFIGURED","Salesforce lead submission is not enabled");
    return this.db.withAgent(scope.agentId,async client => {
      const ticket = await authorizedTicket(client,scope,ticketId,true);
      if (ticket["status"] === "closed") throw new PersistenceError("CONFLICT","Ticket is closed");
      const identity = await client.query<{agent_key:string}>("SELECT agent_key FROM agents WHERE id=$1",[scope.agentId]);
      if (identity.rows[0]?.agent_key !== "ancfz") throw new PersistenceError("NOT_FOUND","Operation unavailable for this agent");
      const eligible = await client.query(
        "SELECT 1 FROM ticket_intents ti JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id WHERE ti.agent_id=$1 AND ti.ticket_id=$2 AND ti.status='active' AND 'create_lead'=ANY(i.allowed_actions) LIMIT 1",
        [scope.agentId,ticketId],
      );
      if (!eligible.rows.length) throw new PersistenceError("CONFLICT","Select a supported lead intent before submitting");
      const existing = await client.query<{
        id:string; state:string; payload_digest:string; provider_reference:string|null; updated_at:Date;
      }>(
        "SELECT id,state,payload_digest,provider_reference,updated_at FROM ticket_operations WHERE agent_id=$1 AND ticket_id=$2 AND operation_key='ancfz_salesforce_lead'",
        [scope.agentId,ticketId],
      );
      const prior=existing.rows[0];
      if (prior) {
        if (prior.payload_digest !== digest) throw new PersistenceError("CONFLICT","Lead submission already exists; review its status before modifying");
        return {operation:{
          id:prior.id,operation:"ancfz_salesforce_lead" as const,state:prior.state,
          providerReference:prior.provider_reference,updatedAt:prior.updated_at.toISOString(),
        },duplicated:true};
      }
      const payload = JSON.stringify({
        agentKey:"ancfz",ticketId,consent:true,...lead,
      });
      const inserted = await client.query<{id:string}>(
        "INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,idempotency_key) VALUES($1,$2,'ancfz_salesforce_lead',$3::jsonb,$4) RETURNING id",
        [scope.agentId,ticketId,payload,"ancfz-lead:"+requestId],
      );
      const outboxId=inserted.rows[0]?.id;
      if (!outboxId) throw new PersistenceError("DATABASE_ERROR","Operation queue unavailable");
      const created=await client.query<{id:string;state:string;updated_at:Date}>(
        "INSERT INTO ticket_operations(agent_id,ticket_id,outbox_id,operation_key,payload_digest) VALUES($1,$2,$3,'ancfz_salesforce_lead',$4) RETURNING id,state,updated_at",
        [scope.agentId,ticketId,outboxId,digest],
      );
      const row=created.rows[0];
      if (!row) throw new PersistenceError("DATABASE_ERROR","Operation record unavailable");
      await appendEventTx(client,scope.agentId,ticketId,"operation.queued",{
        operationId:row.id,operationType:"ancfz_salesforce_lead",
      });
      return {operation:{
        id:row.id,operation:"ancfz_salesforce_lead" as const,state:row.state,
        providerReference:null,updatedAt:row.updated_at.toISOString(),
      },duplicated:false};
    });
  }

  async list(scope:TicketScope,ticketId:string):Promise<LeadOperationView[]> {
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const result=await client.query<{
        id:string;operation_key:"ancfz_salesforce_lead";state:string;
        provider_reference:string|null;updated_at:Date;
      }>(
        "SELECT id,operation_key,state,provider_reference,updated_at FROM ticket_operations WHERE agent_id=$1 AND ticket_id=$2 ORDER BY consented_at DESC",
        [scope.agentId,ticketId],
      );
      return result.rows.map(r=>({
        id:r.id,operation:r.operation_key,state:r.state,
        providerReference:r.provider_reference,updatedAt:r.updated_at.toISOString(),
      }));
    });
  }
}

/** Parse n8n's evidence, not an HTTP 200 as success. */
export function verifiedLeadResult(raw: unknown, ticketId:string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value=raw as Record<string,unknown>;
  return value.verified===true && value.status==="verified_completed" &&
    value.ticketId===ticketId && typeof value.leadId==="string" &&
    leadIdPattern.test(value.leadId) ? value.leadId : null;
}

export const LEAD_CONSENT_TEXT = AUTHORIZATION_TEXT;
