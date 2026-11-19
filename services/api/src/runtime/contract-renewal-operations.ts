/**
 * ANCFZ sandbox contract renewals. PostgreSQL is the transaction authority.
 * One new ticket/quotation/payment/invoice per renewal; same contract number,
 * incremented agreement revision. No repeat Salesforce lead POST.
 */
import {createHash,randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {PersistenceDatabase,PersistenceError,requireUuid} from "../database/pool.js";
import {authorizedTicket,ticketFromRow,type TicketScope} from "../repositories/types.js";
import {publishedBinding} from "../repositories/agent.js";
import {TicketMessageRepository} from "../repositories/messages.js";
import {appendEventTx} from "../repositories/events.js";
import {assertIdentityDocumentsReadyTx} from "./purchase-operations.js";
import {QuotationOperations,QUOTATION_ACKNOWLEDGMENT} from "./quotation-operations.js";

const contractPattern=/^ANCFZ-SC-[0-9]{4}-[0-9]{6,}$/;
const skuPattern=/^renewal_[a-z0-9_]+$/;
export const RENEWAL_DISCLOSURE=
  "I request this exact non-binding ANCFZ TEST renewal quotation, approve reuse of my existing verified Salesforce enquiry and private synthetic identity evidence, and understand a new OTP, test payment, invoice and agreement revision are required. No licence is renewed by this test.";
type Rate={offeringKey:string;label:string;amount:string;currency:string;priceRevision:number};
type Source={id:string;contract_number:string;agreement_revision:number;sha256:string;
  ticket_id:string;customer_name:string;intent_key:string;lead_id:string;
  source_intent_id:string;};
export type RenewalPreview={available:boolean;reason:string|null;
  sourceContractId:string;contractNumber:string;nextRevision:number;
  customerName:string;options:Rate[];disclosure:string};

function renewalEnabled():boolean {
  return process.env.APP_ENV==="development" && process.env.ANCFZ_RENEWAL_ENABLED==="true";
}
function requestObject(raw:unknown):Record<string,unknown>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new PersistenceError("INVALID_INPUT","Explicit renewal approval required");
  return raw as Record<string,unknown>;
}

/** Used only after independent payment verification; lock in same DB transaction. */
export async function renewalLinkTx(client:PoolClient,agentId:string,ticketId:string){
  const r=await client.query<{source_contract_id:string;contract_number:string;source_revision:number}>(
    "SELECT r.source_contract_id,r.contract_number,r.source_revision "+
    "FROM ticket_contract_renewals r WHERE r.agent_id=$1 AND r.renewal_ticket_id=$2 "+
    "AND r.status='requested' FOR UPDATE",
    [agentId,ticketId]);
  return r.rows[0]??null;
}

export class ContractRenewalOperations {
  constructor(private readonly db:PersistenceDatabase){}
  private async source(client:PoolClient,scope:TicketScope,sourceTicketId:string,contractId:string):
    Promise<Source>{
    await authorizedTicket(client,scope,sourceTicketId,true);
    const r=await client.query<Source>(
      "SELECT c.id,c.contract_number,c.agreement_revision,c.sha256,c.ticket_id,"+
      "q.customer_name,i.intent_key,lead.provider_reference AS lead_id,i.id AS source_intent_id "+
      "FROM ticket_service_contracts c "+
      "JOIN ticket_quotations q ON q.agent_id=c.agent_id AND q.ticket_id=c.ticket_id AND q.id=c.quotation_id "+
      "JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id AND p.ticket_id=c.ticket_id "+
      "AND p.id=c.payment_id AND p.state='verified_test_payment' "+
      "JOIN ticket_payment_invoices inv ON inv.agent_id=c.agent_id AND inv.ticket_id=c.ticket_id "+
      "AND inv.payment_id=c.payment_id AND inv.state='verified_completed' AND inv.bytes IS NOT NULL "+
      "JOIN ticket_intents ti ON ti.agent_id=c.agent_id AND ti.ticket_id=c.ticket_id AND ti.status='active' "+
      "JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id "+
      "AND 'generate_quote'=ANY(i.allowed_actions) AND 'purchase_quotation'=ANY(i.allowed_actions) "+
      "JOIN ticket_operations lead ON lead.agent_id=c.agent_id AND lead.ticket_id=c.ticket_id "+
      "AND lead.operation_key='ancfz_salesforce_lead' AND lead.state='verified_completed' "+
      "AND lead.provider_reference ~ '^00Q[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$' "+
      "WHERE c.agent_id=$1 AND c.ticket_id=$2 AND c.id=$3 "+
      "AND c.state='verified_completed' AND c.bytes IS NOT NULL "+
      "AND c.contract_number ~ '^ANCFZ-SC-[0-9]{4}-[0-9]{6,}$' "+
      "FOR UPDATE OF c",
      [scope.agentId,sourceTicketId,contractId]);
    const src=r.rows[0];
    if(!src||!src.sha256||!contractPattern.test(src.contract_number))
      throw new PersistenceError("NOT_FOUND","Verified source contract unavailable");
    const newer=await client.query(
      "SELECT 1 FROM ticket_service_contracts "+
      "WHERE agent_id=$1 AND contract_number=$2 AND agreement_revision>$3 LIMIT 1",
      [scope.agentId,src.contract_number,src.agreement_revision]);
    if(newer.rows.length)throw new PersistenceError("CONFLICT","Select the latest agreement revision");
    const waiting=await client.query(
      "SELECT 1 FROM ticket_contract_renewals "+
      "WHERE agent_id=$1 AND contract_number=$2 AND status='requested' LIMIT 1",
      [scope.agentId,src.contract_number]);
    if(waiting.rows.length)
      throw new PersistenceError("CONFLICT","This agreement already has a renewal in progress");
    await assertIdentityDocumentsReadyTx(client,scope.agentId,src.ticket_id,src.source_intent_id);
    return src;
  }

  private async rates(client:PoolClient,agentId:string,source:Source,
    catalogVersionId:string):Promise<Rate[]>{
    const r=await client.query<{offering_key:string;label:string;amount:string;currency:string;revision:number}>(
      "SELECT o.offering_key,o.label,pr.amount::text AS amount,pr.currency,pr.revision "+
      "FROM offerings o JOIN LATERAL ("+
      " SELECT p.amount,p.currency,p.revision FROM offering_price_revisions p "+
      " WHERE p.agent_id=o.agent_id AND p.offering_id=o.id "+
      " AND p.effective_from<=now() AND (p.effective_to IS NULL OR p.effective_to>now()) "+
      " ORDER BY p.revision DESC LIMIT 1) pr ON true "+
      "WHERE o.agent_id=$1 AND o.catalog_version_id=$2 AND o.intent_key=$3 "+
      "AND o.offering_key ~ '^renewal_[a-z0-9_]+$' "+
      "AND pr.amount>0 AND pr.currency='AED' ORDER BY o.offering_key",
      [agentId,catalogVersionId,source.intent_key]);
    return r.rows.map(x=>({offeringKey:x.offering_key,label:x.label,
      amount:x.amount,currency:x.currency.trim(),priceRevision:x.revision}));
  }

  async preview(scope:TicketScope,sourceTicketId:string,contractId:string):Promise<RenewalPreview>{
    requireUuid(sourceTicketId,"sourceTicketId");requireUuid(contractId,"contractId");
    if(!renewalEnabled())
      return {available:false,reason:"Sandbox renewals are disabled",sourceContractId:contractId,
        contractNumber:"",nextRevision:0,customerName:"",options:[],disclosure:RENEWAL_DISCLOSURE};
    return this.db.withAgent(scope.agentId,async client=>{
      const src=await this.source(client,scope,sourceTicketId,contractId);
      const binding=await publishedBinding(client,scope.agentId);
      const rates=binding.offeringCatalogVersionId
        ?await this.rates(client,scope.agentId,src,binding.offeringCatalogVersionId):[];
      return {available:rates.length>0,reason:rates.length?null:
        "No owner-published renewal-specific price is available. No quotation or payment can be created.",
        sourceContractId:src.id,contractNumber:src.contract_number,
        nextRevision:src.agreement_revision+1,customerName:src.customer_name,
        options:rates,disclosure:RENEWAL_DISCLOSURE};
    });
  }

  async start(scope:TicketScope,sourceTicketId:string,contractId:string,raw:unknown){
    requireUuid(sourceTicketId,"sourceTicketId");requireUuid(contractId,"contractId");
    if(!renewalEnabled())throw new PersistenceError("NOT_CONFIGURED","Sandbox renewals are disabled");
    const input=requestObject(raw);
    if(Object.keys(input).some(k=>!["requestId","offeringKey","priceRevision","amount","currency",
      "consent","consentText"].includes(k))||
      typeof input.requestId!=="string"||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).test(input.requestId)||
      typeof input.offeringKey!=="string"||!skuPattern.test(input.offeringKey)||
      !Number.isSafeInteger(input.priceRevision)||Number(input.priceRevision)<1||
      typeof input.amount!=="string"||!(/^[0-9]{1,12}\.[0-9]{2}$/).test(input.amount)||
      input.currency!=="AED"||input.consent!==true||input.consentText!==RENEWAL_DISCLOSURE)
      throw new PersistenceError("INVALID_INPUT","Approve the exact published renewal price and disclosure");
    const requestId=input.requestId.toLowerCase();
    const result=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,sourceTicketId,true);
      const old=await client.query<{source_contract_id:string;source_ticket_id:string;
        contract_number:string;renewal_ticket_id:string;offering_key:string;amount:string;
        price_revision:number;currency:string;customer_name:string}>(
        "SELECT r.source_contract_id,r.source_ticket_id,r.contract_number,r.renewal_ticket_id,"+
        "r.offering_key,r.amount::text,r.price_revision,r.currency,q.customer_name "+
        "FROM ticket_contract_renewals r "+
        "JOIN ticket_service_contracts c ON c.agent_id=r.agent_id AND c.id=r.source_contract_id "+
        "JOIN ticket_quotations q ON q.agent_id=c.agent_id AND q.ticket_id=c.ticket_id "+
        "AND q.id=c.quotation_id WHERE r.agent_id=$1 AND r.request_id=$2",
        [scope.agentId,requestId]);
      if(old.rows[0]){
        const x=old.rows[0];
        if(x.source_ticket_id!==sourceTicketId||x.source_contract_id!==contractId||
          x.offering_key!==input.offeringKey||x.price_revision!==input.priceRevision||
          x.amount!==input.amount||x.currency.trim()!=="AED")
          throw new PersistenceError("CONFLICT","Renewal request ID already has a different scope");
        await authorizedTicket(client,scope,x.renewal_ticket_id);
        return {ticketId:x.renewal_ticket_id,contractNumber:x.contract_number,
          customerName:x.customer_name,revision:0,duplicated:true};
      }
      const source=await this.source(client,scope,sourceTicketId,contractId);
      const binding=await publishedBinding(client,scope.agentId);
      if(!binding.intentCatalogVersionId||!binding.offeringCatalogVersionId)
        throw new PersistenceError("NOT_CONFIGURED","Published renewal catalogs required");
      const prices=await this.rates(client,scope.agentId,source,binding.offeringCatalogVersionId);
      const rate=prices.find(x=>x.offeringKey===input.offeringKey&&
        x.priceRevision===input.priceRevision&&x.amount===input.amount&&x.currency===input.currency);
      if(!rate)throw new PersistenceError("CONFLICT","Published renewal price changed; review again");
      const intent=await client.query<{id:string}>(
        "SELECT id FROM intents WHERE agent_id=$1 AND catalog_version_id=$2 "+
        "AND intent_key=$3 AND 'generate_quote'=ANY(allowed_actions) "+
        "AND 'purchase_quotation'=ANY(allowed_actions) LIMIT 1",
        [scope.agentId,binding.intentCatalogVersionId,source.intent_key]);
      const intentId=intent.rows[0]?.id;
      if(!intentId)throw new PersistenceError("CONFLICT","Renewal intent is not published");
      const original=await authorizedTicket(client,scope,sourceTicketId);
      const ticket=await client.query<Record<string,unknown>>(
        "INSERT INTO tickets(agent_id,agent_version_id,intent_catalog_version_id,"+
        "offering_catalog_version_id,guest_session_id,account_id,subject) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [scope.agentId,binding.versionId,binding.intentCatalogVersionId,
          binding.offeringCatalogVersionId,original["guest_session_id"]??null,
          original["account_id"]??null,"Renewal of "+source.contract_number]);
      const next=ticketFromRow(ticket.rows[0]!);
      await client.query(
        "INSERT INTO ticket_intents(agent_id,ticket_id,intent_id,status) VALUES($1,$2,$3,'active')",
        [scope.agentId,next.id,intentId]);
      await appendEventTx(client,scope.agentId,next.id,"ticket.created",
        {ticketId:next.id,subject:next.subject});
      const consent=await new TicketMessageRepository(this.db).createCustomerMessageTx(
        client,scope,next.id,requestId,RENEWAL_DISCLOSURE);
      // Replay sourced facts with fresh customer authorization; never grant provenance to the LLM.
      await client.query(
        "INSERT INTO ticket_facts(agent_id,ticket_id,fact_key,value,verification_status,source_message_id) "+
        "SELECT agent_id,$3,fact_key,value,'customer_stated',$4 FROM ticket_facts "+
        "WHERE agent_id=$1 AND ticket_id=$2 AND verification_status<>'disputed'",
        [scope.agentId,sourceTicketId,next.id,consent.message.id]);
      await client.query(
        "INSERT INTO ticket_fact_events(agent_id,ticket_id,fact_id,old_value,new_value,source_message_id,new_verification_status) "+
        "SELECT agent_id,ticket_id,id,NULL,value,$3,'customer_stated' FROM ticket_facts "+
        "WHERE agent_id=$1 AND ticket_id=$2",
        [scope.agentId,next.id,consent.message.id]);
      // Copy exactly approved private evidence (including OCR provenance) to the new scoped ticket.
      // Originals and prior PDF remain immutable. No model tool/n8n payload contains these bytes.
      const copied=await client.query<{requirement_key:string}>(
        "INSERT INTO ticket_purchase_documents(agent_id,ticket_id,intent_id,requirement_id,"+
        "file_name,content_type,bytes,sha256,state,extracted_full_name,document_number_last4,"+
        "extraction_model,extraction_status) "+
        "SELECT d.agent_id,$3,$4,n.id,d.file_name,d.content_type,d.bytes,d.sha256,"+
        "d.state,d.extracted_full_name,d.document_number_last4,d.extraction_model,d.extraction_status "+
        "FROM ticket_purchase_documents d "+
        "JOIN intent_document_requirements oldr ON oldr.agent_id=d.agent_id "+
        "AND oldr.intent_id=d.intent_id AND oldr.id=d.requirement_id "+
        "JOIN intent_document_requirements n ON n.agent_id=d.agent_id AND n.intent_id=$4 "+
        "AND n.requirement_key=oldr.requirement_key "+
        "WHERE d.agent_id=$1 AND d.ticket_id=$2 AND d.state='received' "+
        "AND oldr.requirement_key IN ('passport','emirates_id') RETURNING "+
        "(SELECT requirement_key FROM intent_document_requirements WHERE id=requirement_id) AS requirement_key",
        [scope.agentId,sourceTicketId,next.id,intentId]);
      if(copied.rows.length!==2)
        throw new PersistenceError("CONFLICT","Both original private identity documents must be available");
      await assertIdentityDocumentsReadyTx(client,scope.agentId,next.id,intentId);
      // Copy only trusted independently verified provider identity. Outbox is already completed.
      const outbox=await client.query<{id:string}>(
        "INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,status,idempotency_key) "+
        "VALUES($1,$2,'ancfz_salesforce_lead',$3::jsonb,'completed',$4) RETURNING id",
        [scope.agentId,next.id,JSON.stringify({renewalReuse:true,sourceContractId:source.id}),
          "renewal-lead-reuse:"+next.id]);
      const digest=createHash("sha256").update(source.lead_id+":"+next.id).digest("hex");
      await client.query(
        "INSERT INTO ticket_operations(agent_id,ticket_id,outbox_id,operation_key,"+
        "payload_digest,state,provider_reference,provider_status) "+
        "VALUES($1,$2,$3,'ancfz_salesforce_lead',$4,'verified_completed',$5,'renewal_reused_verified_lead')",
        [scope.agentId,next.id,outbox.rows[0]!.id,digest,source.lead_id]);
      await client.query(
        "INSERT INTO ticket_contract_renewals(agent_id,source_contract_id,contract_number,"+
        "source_revision,source_ticket_id,renewal_ticket_id,request_id,offering_key,"+
        "price_revision,amount,currency,source_document_sha256) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',$11)",
        [scope.agentId,source.id,source.contract_number,source.agreement_revision,
          sourceTicketId,next.id,requestId,rate.offeringKey,rate.priceRevision,rate.amount,source.sha256]);
      await appendEventTx(client,scope.agentId,next.id,"contract.renewal.requested",
        {contractNumber:source.contract_number,previousRevision:source.agreement_revision,
          nextRevision:source.agreement_revision+1,amount:rate.amount,currency:"AED",
          offeringKey:rate.offeringKey,priceRevision:rate.priceRevision,testOnly:true});
      await new TicketMessageRepository(this.db).createAssistantMessageTx(
        client,scope,next.id,randomUUID(),
        "Your renewal for **"+source.contract_number+"** has been requested at **AED "+
        rate.amount+"**. The original agreement and invoice remain unchanged. "+
        "A fresh non-binding quotation is being prepared. Please verify its OTP before "+
        "sandbox payment. A new TEST invoice and agreement revision require an independently verified payment.",[]);
      return {ticketId:next.id,contractNumber:source.contract_number,
        customerName:source.customer_name,revision:source.agreement_revision+1,duplicated:false};
    });
    // Never duplicate the Salesforce lead. Quote dispatch is idempotent and may be
    // retried with the SAME source authorization if the renderer was unavailable.
    const quote=await new QuotationOperations(this.db).submit(scope,result.ticketId,{
      requestId,customerName:result.customerName,offeringKey:input.offeringKey,
      acknowledged:true,acknowledgmentText:QUOTATION_ACKNOWLEDGMENT,
    },{amount:String(input.amount),currency:"AED",priceRevision:Number(input.priceRevision)});
    return {ticketId:result.ticketId,contractNumber:result.contractNumber,
      nextRevision:result.revision||undefined,quotationId:quote.quotation.id,
      quotationState:quote.quotation.state,duplicated:result.duplicated};
  }
}
