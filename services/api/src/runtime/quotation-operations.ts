/**
 * P4 quotation action. No model call can authorize a quotation.
 * Customer approves the exact offering; Node resolves the ticket-pinned
 * catalog and effective price, and requires a verified Salesforce Lead.
 */
import { createHash, randomUUID } from "node:crypto";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { authorizedTicket, type TicketScope } from "../repositories/types.js";

export const QUOTATION_ACKNOWLEDGMENT =
  "I request a non-binding ANCFZ test quotation for the selected published package price, subject to ANCFZ confirmation.";

export function quoteDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANCFZ_QUOTE_DISPATCH_ENABLED === "true" &&
    typeof env.ANCFZ_N8N_WEBHOOK_SECRET === "string" &&
    env.ANCFZ_N8N_WEBHOOK_SECRET.length >= 32;
}

export interface QuoteOption {
  offeringKey:string; label:string; currency:string; amount:string;
  priceRevision:number; conditions:string|null;
}

export interface QuoteView {
  id:string; operationId:string; state:string; documentNumber:string;
  offeringKey:string; offeringLabel:string; priceRevision:number;
  amount:string; currency:string; conditions:string|null;
  createdAt:string; pdfAvailable:boolean;
}

interface PriceRow {
  offering_id:string; price_id:string; offering_key:string; label:string;
  currency:string; amount:string; revision:number; conditions:string|null;
}
interface QuoteRow {
  id:string;operation_id:string;state:string;document_number:string;
  offering_key:string;offering_label:string;price_revision:number;
  amount:string;currency:string;conditions:string|null;
  created_at:Date;pdf_available:boolean;
}
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const offeringPattern=/^[a-z][a-z0-9_]{0,127}$/;

export function parseQuoteRequest(input:unknown):{
  requestId:string;customerName:string;offeringKey:string;
} {
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw new PersistenceError("INVALID_INPUT","Invalid quotation request");
  const body=input as Record<string,unknown>;
  const allowed=new Set(["requestId","customerName","offeringKey","acknowledged","acknowledgmentText"]);
  if(Object.keys(body).some(x=>!allowed.has(x))||
     body.acknowledged!==true||body.acknowledgmentText!==QUOTATION_ACKNOWLEDGMENT)
    throw new PersistenceError("INVALID_INPUT","Explicit non-binding quotation acknowledgment required");
  if(typeof body.requestId!=="string"||!uuidPattern.test(body.requestId))
    throw new PersistenceError("INVALID_INPUT","Invalid request ID");
  if(typeof body.customerName!=="string"||!body.customerName.trim()||body.customerName.length>200)
    throw new PersistenceError("INVALID_INPUT","Invalid customer name");
  if(typeof body.offeringKey!=="string"||!offeringPattern.test(body.offeringKey))
    throw new PersistenceError("INVALID_INPUT","Invalid offering key");
  return {
    requestId:body.requestId.toLowerCase(),
    customerName:body.customerName.trim(),
    offeringKey:body.offeringKey,
  };
}

function toView(row:QuoteRow):QuoteView {
  return {
    id:row.id,operationId:row.operation_id,state:row.state,
    documentNumber:row.document_number,offeringKey:row.offering_key,
    offeringLabel:row.offering_label,priceRevision:row.price_revision,
    amount:row.amount,currency:row.currency.trim(),conditions:row.conditions,
    createdAt:row.created_at.toISOString(),pdfAvailable:row.pdf_available,
  };
}

const quoteSelect = `
SELECT q.id,q.operation_id,op.state,q.document_number,q.offering_key,
  q.offering_label,q.price_revision,q.amount::text AS amount,
  q.currency,q.conditions,q.created_at,
  EXISTS(SELECT 1 FROM ticket_quotation_pdfs d
         WHERE d.agent_id=q.agent_id AND d.ticket_id=q.ticket_id
           AND d.quotation_id=q.id) AS pdf_available
FROM ticket_quotations q
JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.ticket_id=q.ticket_id
  AND op.id=q.operation_id AND op.operation_key='ancfz_render_quote'
WHERE q.agent_id=$1 AND q.ticket_id=$2`;

async function requireEligibleTicket(client: import("pg").PoolClient, agentId:string, ticketId:string):Promise<string> {
  const selected=await client.query<{lead_id:string}>(
    `SELECT lead.provider_reference AS lead_id
     FROM tickets t
     JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active'
     JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
       AND i.catalog_version_id=t.intent_catalog_version_id
     JOIN ticket_operations lead ON lead.agent_id=t.agent_id AND lead.ticket_id=t.id
       AND lead.operation_key='ancfz_salesforce_lead' AND lead.state='verified_completed'
     JOIN agents a ON a.id=t.agent_id AND a.agent_key='ancfz'
     WHERE t.agent_id=$1 AND t.id=$2 AND t.status<>'closed'
       AND 'generate_quote'=ANY(i.allowed_actions)
       AND lead.provider_reference ~ '^00Q[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'
     LIMIT 1`,
    [agentId,ticketId],
  );
  const leadId=selected.rows[0]?.lead_id;
  if(!leadId)throw new PersistenceError("CONFLICT","A verified ANCFZ Salesforce Lead and supported intent are required");
  return leadId;
}

async function pricedOptions(
  client: import("pg").PoolClient,agentId:string,ticketId:string,
  key?:string,
):Promise<PriceRow[]> {
  const result=await client.query<PriceRow>(
    `SELECT o.id AS offering_id,p.id AS price_id,o.offering_key,o.label,
       p.currency,p.amount::text AS amount,p.revision,p.conditions
     FROM tickets t
     JOIN offering_catalog_versions cv ON cv.agent_id=t.agent_id
       AND cv.id=t.offering_catalog_version_id
       AND cv.status IN ('published','retired')
     JOIN offerings o ON o.agent_id=t.agent_id AND o.catalog_version_id=cv.id
     JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id
       AND ti.status='active'
     JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
       AND i.catalog_version_id=t.intent_catalog_version_id
       AND o.intent_key=i.intent_key
     JOIN LATERAL (
       SELECT pr.id,pr.currency,pr.amount,pr.revision,pr.conditions
       FROM offering_price_revisions pr
       WHERE pr.agent_id=o.agent_id AND pr.offering_id=o.id
         AND pr.effective_from<=now()
         AND (pr.effective_to IS NULL OR pr.effective_to>now())
       ORDER BY pr.revision DESC LIMIT 1
     ) p ON true
     WHERE t.agent_id=$1 AND t.id=$2
       AND 'generate_quote'=ANY(i.allowed_actions)
       AND p.amount>0
       AND ($3::text IS NULL OR o.offering_key=$3)
     ORDER BY o.offering_key`,
    [agentId,ticketId,key??null],
  );
  return result.rows;
}

export class QuotationOperations {
  constructor(private readonly db:PersistenceDatabase) {}

  async options(scope:TicketScope,ticketId:string):Promise<{
    enabled:boolean;leadVerified:boolean;options:QuoteOption[];
  }> {
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const enabled=quoteDispatchEnabled();
      if(!enabled)return {enabled:false,leadVerified:false,options:[]};
      try {
        await requireEligibleTicket(client,scope.agentId,ticketId);
      }catch(error) {
        if(error instanceof PersistenceError&&error.code==="CONFLICT")
          return {enabled:true,leadVerified:false,options:[]};
        throw error;
      }
      const rows=await pricedOptions(client,scope.agentId,ticketId);
      return {enabled:true,leadVerified:true,
        options:rows.map(r=>({
          offeringKey:r.offering_key,label:r.label,
          currency:r.currency.trim(),amount:r.amount,
          priceRevision:r.revision,conditions:r.conditions,
        })),
      };
    });
  }

  async get(scope:TicketScope,ticketId:string):Promise<QuoteView|null> {
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const r=await client.query<QuoteRow>(quoteSelect,[scope.agentId,ticketId]);
      return r.rows[0]?toView(r.rows[0]):null;
    });
  }

  async submit(scope:TicketScope,ticketId:string,raw:unknown):Promise<{quotation:QuoteView;duplicated:boolean}> {
    requireUuid(ticketId,"ticketId");
    const input=parseQuoteRequest(raw);
    if(process.env.APP_ENV==="production"&&!process.env.PUBLIC_BASE_URL?.startsWith("https://"))
      throw new PersistenceError("NOT_CONFIGURED","HTTPS required for customer quotation requests");
    if(!quoteDispatchEnabled())
      throw new PersistenceError("NOT_CONFIGURED","ANCFZ quotation rendering is not enabled");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const existing=await client.query<QuoteRow>(quoteSelect,[scope.agentId,ticketId]);
      if(existing.rows[0]) {
        const stored=existing.rows[0];
        const name=await client.query<{customer_name:string}>(
          "SELECT customer_name FROM ticket_quotations WHERE agent_id=$1 AND ticket_id=$2",
          [scope.agentId,ticketId],
        );
        if(stored.offering_key!==input.offeringKey||
           name.rows[0]?.customer_name!==input.customerName)
          throw new PersistenceError("CONFLICT","Quotation already exists; changing the package needs a new authorization");
        return {quotation:toView(stored),duplicated:true};
      }
      const leadId=await requireEligibleTicket(client,scope.agentId,ticketId);
      const options=await pricedOptions(client,scope.agentId,ticketId,input.offeringKey);
      const chosen=options[0];
      if(!chosen)throw new PersistenceError("CONFLICT","Selected offering has no effective published price");
      const amount=Number(chosen.amount);
      if(!Number.isFinite(amount)||amount<=0||
         !/^\d{1,12}\.\d{2}$/.test(chosen.amount))
        throw new PersistenceError("CONFLICT","Invalid authoritative price");
      const quotationId=randomUUID();
      const documentNumber="ANCFZ-TEST-Q-"+quotationId;
      const payload={
        agentKey:"ancfz",ticketId,documentType:"quotation" as const,
        documentNumber,customerName:input.customerName,
        currency:chosen.currency.trim(),
        lines:[{label:chosen.label,amount}],total:amount,
      };
      const outbox=await client.query<{id:string}>(
        "INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,idempotency_key) VALUES($1,$2,'ancfz_render_quote',$3::jsonb,$4) RETURNING id",
        [scope.agentId,ticketId,JSON.stringify(payload),"ancfz-quote:"+input.requestId],
      );
      const outboxId=outbox.rows[0]?.id;
      if(!outboxId)throw new PersistenceError("DATABASE_ERROR","Quotation queue unavailable");
      const digest=createHash("sha256").update(JSON.stringify({
        quotationId,leadId,priceRevision:chosen.price_id,price:chosen.amount,
        currency:chosen.currency,customerName:input.customerName,
      })).digest("hex");
      const operation=await client.query<{id:string}>(
        "INSERT INTO ticket_operations(agent_id,ticket_id,outbox_id,operation_key,payload_digest) VALUES($1,$2,$3,'ancfz_render_quote',$4) RETURNING id",
        [scope.agentId,ticketId,outboxId,digest],
      );
      const operationId=operation.rows[0]?.id;
      if(!operationId)throw new PersistenceError("DATABASE_ERROR","Quotation operation unavailable");
      await client.query(
        `INSERT INTO ticket_quotations(
           id,agent_id,ticket_id,operation_id,offering_id,price_revision_id,
           price_revision,offering_key,offering_label,customer_name,
           salesforce_lead_id,document_number,amount,currency,conditions
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [quotationId,scope.agentId,ticketId,operationId,chosen.offering_id,
          chosen.price_id,chosen.revision,chosen.offering_key,chosen.label,
          input.customerName,leadId,documentNumber,chosen.amount,
          chosen.currency.trim(),chosen.conditions],
      );
      await appendEventTx(client,scope.agentId,ticketId,"operation.queued",{
        operationId,quotationId,operationType:"ancfz_render_quote",
        documentNumber,
      });
      const fresh=await client.query<QuoteRow>(quoteSelect,[scope.agentId,ticketId]);
      if(!fresh.rows[0])throw new PersistenceError("DATABASE_ERROR","Quotation not persisted");
      return {quotation:toView(fresh.rows[0]),duplicated:false};
    });
  }

  async pdf(scope:TicketScope,ticketId:string,quotationId:string):Promise<{
    bytes:Buffer;documentNumber:string;sha256:string;
  }> {
    requireUuid(ticketId,"ticketId");
    requireUuid(quotationId,"quotationId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const found=await client.query<{bytes:Buffer;document_number:string;sha256:string}>(
        `SELECT d.bytes,q.document_number,d.sha256 FROM ticket_quotation_pdfs d
         JOIN ticket_quotations q ON q.agent_id=d.agent_id AND q.ticket_id=d.ticket_id
           AND q.id=d.quotation_id
         JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.ticket_id=q.ticket_id
           AND op.id=q.operation_id
         WHERE d.agent_id=$1 AND d.ticket_id=$2 AND d.quotation_id=$3
           AND op.state='verified_completed'`,
        [scope.agentId,ticketId,quotationId],
      );
      const doc=found.rows[0];
      if(!doc)throw new PersistenceError("NOT_FOUND","Quotation PDF unavailable");
      return {bytes:doc.bytes,documentNumber:doc.document_number,sha256:doc.sha256};
    });
  }
}
