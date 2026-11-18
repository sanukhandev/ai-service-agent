/**
 * Owner-approved ANCFZ sandbox renewal. Create a distinct ticket for a fresh
 * quotation/payment/invoice while reusing the existing verified agreement and
 * already authorized identity evidence. No CRM, n8n or payment POST happens here.
 */
import {createHash,randomUUID} from "node:crypto";
import {PersistenceDatabase,PersistenceError,requireUuid} from "../database/pool.js";
import {authorizedTicket,type TicketScope,ticketFromRow} from "../repositories/types.js";
import {publishedBinding} from "../repositories/agent.js";
import {TicketMessageRepository} from "../repositories/messages.js";
import {appendEventTx} from "../repositories/events.js";

export const RENEWAL_START_CONSENT=
  "I request a fresh ANCFZ sandbox renewal quotation and authorize reusing my previously recorded company details, verified Salesforce enquiry reference and privately stored synthetic identity documents for this agreement renewal. I understand a new payment and invoice are required.";
export const RENEWAL_PURCHASE_CONSENT=
  "I approve the new ANCFZ sandbox renewal quotation and authorize reusing my original private passport and Emirates ID annexures in an updated nonbinding TEST service agreement, only after independent verification of this renewal payment.";
const agreementPattern=/^ANCFZ-AGR-[0-9]{4}-[0-9]{6,}$/;
const requestPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type RenewalStatus={ticketId:string;agreementNumber:string;revision:number;reusedVerifiedLead:boolean;newQuoteRequired:true;newPaymentRequired:true};
export class RenewalOperations{
  constructor(private readonly db:PersistenceDatabase){}
  async start(scope:TicketScope,sourceTicketId:string,raw:unknown):Promise<RenewalStatus>{
    requireUuid(sourceTicketId,"sourceTicketId");
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Explicit renewal consent required");
    const v=raw as Record<string,unknown>;
    if(Object.keys(v).some(k=>!["requestId","agreementNumber","consent","consentText"].includes(k))||
       typeof v.requestId!=="string"||!requestPattern.test(v.requestId)||
       typeof v.agreementNumber!=="string"||!agreementPattern.test(v.agreementNumber)||
       v.consent!==true||v.consentText!==RENEWAL_START_CONSENT)
      throw new PersistenceError("INVALID_INPUT","Review and approve the exact agreement renewal request");
    if(process.env.APP_ENV!=="development")
      throw new PersistenceError("NOT_CONFIGURED","Sandbox agreement renewal is available only in development");
    return this.db.withAgent(scope.agentId,async client=>{
      // The ticket owning the CURRENT agreement revision must belong to the
      // authenticated session. Guessing the agreement number is insufficient.
      const source=await authorizedTicket(client,scope,sourceTicketId,true);
      const existing=await client.query<{
        renewal_ticket_id:string;agreement_number:string;source_ticket_id:string;source_revision:number;
      }>(`SELECT r.renewal_ticket_id,a.agreement_number,r.source_ticket_id,r.source_revision
        FROM ticket_renewals r JOIN service_agreements a
          ON a.agent_id=r.agent_id AND a.id=r.agreement_id
        WHERE r.agent_id=$1 AND r.request_id=$2`,[scope.agentId,v.requestId]);
      if(existing.rows[0]){
        const item=existing.rows[0];
        if(item.source_ticket_id!==sourceTicketId||item.agreement_number!==v.agreementNumber)
          throw new PersistenceError("CONFLICT","Renewal request ID was already used");
        await authorizedTicket(client,scope,item.renewal_ticket_id);
        return {ticketId:item.renewal_ticket_id,agreementNumber:item.agreement_number,
          revision:item.source_revision+1,reusedVerifiedLead:true,
          newQuoteRequired:true,newPaymentRequired:true};
      }
      const matched=await client.query<{
        agreement_id:string;current_revision:number;initial_ticket_id:string;
        contract_id:string;
      }>(`SELECT a.id AS agreement_id,a.current_revision,a.initial_ticket_id,
          c.id AS contract_id
        FROM service_agreements a
        JOIN ticket_service_contracts c ON c.agent_id=a.agent_id
          AND c.agreement_id=a.id AND c.revision=a.current_revision
          AND c.state='verified_completed' AND c.bytes IS NOT NULL
        JOIN ticket_payment_invoices i ON i.agent_id=c.agent_id
          AND i.ticket_id=c.ticket_id AND i.id=c.invoice_id
          AND i.state='verified_completed' AND i.bytes IS NOT NULL
        JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id
          AND p.ticket_id=c.ticket_id AND p.id=c.payment_id
          AND p.state='verified_test_payment'
        WHERE a.agent_id=$1 AND a.agreement_number=$2 AND c.ticket_id=$3
          AND a.current_revision>=1 FOR UPDATE OF a`,
        [scope.agentId,v.agreementNumber,sourceTicketId]);
      const master=matched.rows[0];
      if(!master)throw new PersistenceError("NOT_FOUND","Verified current agreement unavailable");
      const pending=await client.query(
        "SELECT 1 FROM ticket_renewals WHERE agent_id=$1 AND agreement_id=$2 AND status='requested' LIMIT 1",
        [scope.agentId,master.agreement_id]);
      if(pending.rows.length)throw new PersistenceError("CONFLICT",
        "A renewal for this agreement is already in progress");
      const originalDocs=await client.query<{requirement_key:string}>(
        `SELECT req.requirement_key FROM ticket_purchase_documents d
         JOIN intent_document_requirements req ON req.agent_id=d.agent_id
           AND req.intent_id=d.intent_id AND req.id=d.requirement_id
         WHERE d.agent_id=$1 AND d.ticket_id=$2 AND d.state='received'
           AND d.extraction_status='extracted'
           AND req.requirement_key IN ('passport','emirates_id')
           AND d.extracted_full_name IS NOT NULL
           AND (req.requirement_key='passport' OR
                d.document_number_last4 ~ '^[0-9]{4}
        [scope.agentId,master.initial_ticket_id]);
      if(!["passport","emirates_id"].every(k=>originalDocs.rows.some(d=>d.requirement_key===k)))
        throw new PersistenceError("CONFLICT","Renewal identity evidence is unavailable; review with Sara");
      const priorIntent=await client.query<{intent_key:string}>(
        `SELECT i.intent_key FROM ticket_intents ti
         JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
         WHERE ti.agent_id=$1 AND ti.ticket_id=$2 AND ti.status='active'
         LIMIT 1`,[scope.agentId,sourceTicketId]);
      const lead=await client.query<{id:string;provider_reference:string}>(
        `SELECT id,provider_reference FROM ticket_operations
         WHERE agent_id=$1 AND ticket_id=$2
           AND operation_key='ancfz_salesforce_lead' AND state='verified_completed'
           AND provider_reference ~ '^00Q[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'
         LIMIT 1`,[scope.agentId,sourceTicketId]);
      if(!priorIntent.rows[0]||!lead.rows[0])
        throw new PersistenceError("CONFLICT","Verified source intent and Salesforce enquiry are required");
      const binding=await publishedBinding(client,scope.agentId);
      if(!binding.intentCatalogVersionId||!binding.offeringCatalogVersionId)
        throw new PersistenceError("NOT_CONFIGURED","Published catalogs required for renewal");
      const selectedIntent=await client.query<{id:string}>(
        `SELECT id FROM intents WHERE agent_id=$1 AND catalog_version_id=$2
           AND intent_key=$3 AND 'generate_quote'=ANY(allowed_actions)
           AND 'purchase_quotation'=ANY(allowed_actions) LIMIT 1`,
        [scope.agentId,binding.intentCatalogVersionId,priorIntent.rows[0].intent_key]);
      if(!selectedIntent.rows[0])
        throw new PersistenceError("CONFLICT","Previous service is no longer offered for renewal");
      const ticket=await client.query<Record<string,unknown>>(
        `INSERT INTO tickets(agent_id,agent_version_id,intent_catalog_version_id,
           offering_catalog_version_id,guest_session_id,account_id,subject)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [scope.agentId,binding.versionId,binding.intentCatalogVersionId,
          binding.offeringCatalogVersionId,source["guest_session_id"]??null,
          source["account_id"]??null,
          "Renewal of "+v.agreementNumber]);
      const newTicket=ticketFromRow(ticket.rows[0]!);
      await appendEventTx(client,scope.agentId,newTicket.id,"ticket.created",{
        ticketId:newTicket.id,subject:newTicket.subject});
      await client.query(
        `INSERT INTO ticket_intents(agent_id,ticket_id,intent_id,status)
         VALUES($1,$2,$3,'active')`,
        [scope.agentId,newTicket.id,selectedIntent.rows[0].id]);
      const description=RENEWAL_START_CONSENT+" Agreement: "+v.agreementNumber+".";
      const message=await new TicketMessageRepository(this.db).createCustomerMessageTx(
        client,scope,newTicket.id,v.requestId,description);
      // A fresh customer authorization is the provenance for using older
      // customer-stated facts. No documents are copied into Foundry or chat.
      await client.query(
        `INSERT INTO ticket_facts(agent_id,ticket_id,fact_key,value,verification_status,source_message_id)
         SELECT agent_id,$3,fact_key,value,'customer_stated',$4
         FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2
           AND verification_status<>'disputed'`,
        [scope.agentId,sourceTicketId,newTicket.id,message.message.id]);
      await client.query(
        `INSERT INTO ticket_fact_events(agent_id,ticket_id,fact_id,old_value,new_value,
           source_message_id,new_verification_status)
         SELECT f.agent_id,f.ticket_id,f.id,NULL,f.value,$3,'customer_stated'
         FROM ticket_facts f WHERE f.agent_id=$1 AND f.ticket_id=$2`,
        [scope.agentId,newTicket.id,message.message.id]);
      // Reuse only an independently verified Salesforce reference. The outbox
      // is already completed; no fresh Salesforce request is ever dispatched.
      const outbox=await client.query<{id:string}>(
        `INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,status,idempotency_key)
         VALUES($1,$2,'ancfz_salesforce_lead',$3::jsonb,'completed',$4) RETURNING id`,
        [scope.agentId,newTicket.id,
          JSON.stringify({renewalReuse:true,sourceLeadOperationId:lead.rows[0].id}),
          "renewal-lead-reuse:"+newTicket.id]);
      await client.query(
        `INSERT INTO ticket_operations(agent_id,ticket_id,outbox_id,operation_key,
           payload_digest,state,provider_reference,provider_status)
         VALUES($1,$2,$3,'ancfz_salesforce_lead',$4,'verified_completed',$5,'reused_verified_lead')`,
        [scope.agentId,newTicket.id,outbox.rows[0]!.id,
          createHash("sha256").update(lead.rows[0].id+":"+newTicket.id).digest("hex"),
          lead.rows[0].provider_reference]);
      await client.query(
        `INSERT INTO ticket_renewals(agent_id,agreement_id,source_ticket_id,
           renewal_ticket_id,request_id,source_revision)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [scope.agentId,master.agreement_id,sourceTicketId,newTicket.id,
          v.requestId,master.current_revision]);
      await appendEventTx(client,scope.agentId,newTicket.id,"agreement.renewal.requested",{
        agreementNumber:v.agreementNumber,sourceTicketId,
        sourceRevision:master.current_revision,nextRevision:master.current_revision+1});
      await new TicketMessageRepository(this.db).createAssistantMessageTx(
        client,scope,newTicket.id,randomUUID(),
        "Your renewal request for agreement **"+v.agreementNumber+
        "** is recorded. Your previous verified Salesforce enquiry reference and approved company details have been carried forward. "+
        "The next step is a **new quotation**. You will review and approve the new price before any sandbox payment. "+
        "The original agreement remains unchanged until the renewal payment and invoice are independently verified.",[]);
      return {ticketId:newTicket.id,agreementNumber:v.agreementNumber,
        revision:master.current_revision+1,reusedVerifiedLead:true,
        newQuoteRequired:true,newPaymentRequired:true};
    });
  }
}
)`,
        [scope.agentId,master.initial_ticket_id]);
      if(!["passport","emirates_id"].every(k=>originalDocs.rows.some(d=>d.requirement_key===k)))
        throw new PersistenceError("CONFLICT","Renewal identity evidence is unavailable; review with Sara");
      const priorIntent=await client.query<{intent_key:string}>(
        `SELECT i.intent_key FROM ticket_intents ti
         JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
         WHERE ti.agent_id=$1 AND ti.ticket_id=$2 AND ti.status='active'
         LIMIT 1`,[scope.agentId,sourceTicketId]);
      const lead=await client.query<{id:string;provider_reference:string}>(
        `SELECT id,provider_reference FROM ticket_operations
         WHERE agent_id=$1 AND ticket_id=$2
           AND operation_key='ancfz_salesforce_lead' AND state='verified_completed'
           AND provider_reference ~ '^00Q[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$'
         LIMIT 1`,[scope.agentId,sourceTicketId]);
      if(!priorIntent.rows[0]||!lead.rows[0])
        throw new PersistenceError("CONFLICT","Verified source intent and Salesforce enquiry are required");
      const binding=await publishedBinding(client,scope.agentId);
      if(!binding.intentCatalogVersionId||!binding.offeringCatalogVersionId)
        throw new PersistenceError("NOT_CONFIGURED","Published catalogs required for renewal");
      const selectedIntent=await client.query<{id:string}>(
        `SELECT id FROM intents WHERE agent_id=$1 AND catalog_version_id=$2
           AND intent_key=$3 AND 'generate_quote'=ANY(allowed_actions)
           AND 'purchase_quotation'=ANY(allowed_actions) LIMIT 1`,
        [scope.agentId,binding.intentCatalogVersionId,priorIntent.rows[0].intent_key]);
      if(!selectedIntent.rows[0])
        throw new PersistenceError("CONFLICT","Previous service is no longer offered for renewal");
      const ticket=await client.query<Record<string,unknown>>(
        `INSERT INTO tickets(agent_id,agent_version_id,intent_catalog_version_id,
           offering_catalog_version_id,guest_session_id,account_id,subject)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [scope.agentId,binding.versionId,binding.intentCatalogVersionId,
          binding.offeringCatalogVersionId,source["guest_session_id"]??null,
          source["account_id"]??null,
          "Renewal of "+v.agreementNumber]);
      const newTicket=ticketFromRow(ticket.rows[0]!);
      await appendEventTx(client,scope.agentId,newTicket.id,"ticket.created",{
        ticketId:newTicket.id,subject:newTicket.subject});
      await client.query(
        `INSERT INTO ticket_intents(agent_id,ticket_id,intent_id,status)
         VALUES($1,$2,$3,'active')`,
        [scope.agentId,newTicket.id,selectedIntent.rows[0].id]);
      const description=RENEWAL_START_CONSENT+" Agreement: "+v.agreementNumber+".";
      const message=await new TicketMessageRepository(this.db).createCustomerMessageTx(
        client,scope,newTicket.id,v.requestId,description);
      // A fresh customer authorization is the provenance for using older
      // customer-stated facts. No documents are copied into Foundry or chat.
      await client.query(
        `INSERT INTO ticket_facts(agent_id,ticket_id,fact_key,value,verification_status,source_message_id)
         SELECT agent_id,$3,fact_key,value,'customer_stated',$4
         FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2
           AND verification_status<>'disputed'`,
        [scope.agentId,sourceTicketId,newTicket.id,message.message.id]);
      await client.query(
        `INSERT INTO ticket_fact_events(agent_id,ticket_id,fact_id,old_value,new_value,
           source_message_id,new_verification_status)
         SELECT f.agent_id,f.ticket_id,f.id,NULL,f.value,$3,'customer_stated'
         FROM ticket_facts f WHERE f.agent_id=$1 AND f.ticket_id=$2`,
        [scope.agentId,newTicket.id,message.message.id]);
      // Reuse only an independently verified Salesforce reference. The outbox
      // is already completed; no fresh Salesforce request is ever dispatched.
      const outbox=await client.query<{id:string}>(
        `INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,status,idempotency_key)
         VALUES($1,$2,'ancfz_salesforce_lead',$3::jsonb,'completed',$4) RETURNING id`,
        [scope.agentId,newTicket.id,
          JSON.stringify({renewalReuse:true,sourceLeadOperationId:lead.rows[0].id}),
          "renewal-lead-reuse:"+newTicket.id]);
      await client.query(
        `INSERT INTO ticket_operations(agent_id,ticket_id,outbox_id,operation_key,
           payload_digest,state,provider_reference,provider_status)
         VALUES($1,$2,$3,'ancfz_salesforce_lead',$4,'verified_completed',$5,'reused_verified_lead')`,
        [scope.agentId,newTicket.id,outbox.rows[0]!.id,
          createHash("sha256").update(lead.rows[0].id+":"+newTicket.id).digest("hex"),
          lead.rows[0].provider_reference]);
      await client.query(
        `INSERT INTO ticket_renewals(agent_id,agreement_id,source_ticket_id,
           renewal_ticket_id,request_id,source_revision)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [scope.agentId,master.agreement_id,sourceTicketId,newTicket.id,
          v.requestId,master.current_revision]);
      await appendEventTx(client,scope.agentId,newTicket.id,"agreement.renewal.requested",{
        agreementNumber:v.agreementNumber,sourceTicketId,
        sourceRevision:master.current_revision,nextRevision:master.current_revision+1});
      await new TicketMessageRepository(this.db).createAssistantMessageTx(
        client,scope,newTicket.id,randomUUID(),
        "Your renewal request for agreement **"+v.agreementNumber+
        "** is recorded. Your previous verified Salesforce enquiry reference and approved company details have been carried forward. "+
        "The next step is a **new quotation**. You will review and approve the new price before any sandbox payment. "+
        "The original agreement remains unchanged until the renewal payment and invoice are independently verified.",[]);
      return {ticketId:newTicket.id,agreementNumber:v.agreementNumber,
        revision:master.current_revision+1,reusedVerifiedLead:true,
        newQuoteRequired:true,newPaymentRequired:true};
    });
  }
}
