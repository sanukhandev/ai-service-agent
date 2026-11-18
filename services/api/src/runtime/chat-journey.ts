/**
 * Customer-message-driven ANCFZ journey. Foundry extracts sourced facts;
 * Node alone proposes immutable transactions, records exact conversational
 * authorization and dispatches through existing provider-verifying operations.
 *
 * External POSTs are never retried on ambiguous outcomes. Checkout remains
 * hosted; identity documents and OTPs never enter Foundry/chat messages.
 */
import { createHash } from "node:crypto";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { authorizedTicket, workerTicketScope, type TicketScope } from "../repositories/types.js";
import { appendEventTx } from "../repositories/events.js";
import { lifecycleNoticeId, TicketMessageRepository } from "../repositories/messages.js";
import { LeadOperations, LEAD_CONSENT_TEXT, leadDispatchEnabled, parseSalesforceLeadName, type LeadFields } from "./lead-operations.js";
import { QuotationOperations, QUOTATION_ACKNOWLEDGMENT, quoteDispatchEnabled } from "./quotation-operations.js";
import { PurchaseOperations, PURCHASE_CONSENT } from "./purchase-operations.js";
import { PaymentOperations, parseStartOtp } from "./payment-operations.js";
import { QuotationConfirmationOperations } from "./quotation-confirmation.js";
import { normalizeContactPhone, validateConversationFact } from "./fact-validation.js";
import { PAYMENT_CONSENT, paymentEnabled, paymentReadEnabled } from "./payment-evidence.js";
import {quoteDetails,quoteDetailsMarkdown,quoteRequirementsTx,
  type QuoteProposalDetails} from "./quote-proposal.js";

export const LEAD_QUOTE_APPROVAL =
  "I authorize ANCFZ to send my contact details to Salesforce and prepare the non-binding quotation shown.";
export const PURCHASE_PAYMENT_APPROVAL =
  "I authorize the ANCFZ sandbox purchase and test payment for the exact quotation amount shown.";

type ProposalKind="lead_quote"|"purchase_payment";
type LeadQuoteData={
  lead:LeadFields; offeringKey:string;priceRevision:number;amount:string;
  currency:string;visaCount:number;termYears:number;officePreference:string;
  conditions:string|null;offeringLabel:string;proposal:QuoteProposalDetails;
};
type PurchaseData={
  quotationId:string;amount:string;currency:string;billingName:string;testEmail:string;
};
type ProposalPayload={kind:ProposalKind;data:LeadQuoteData|PurchaseData;fingerprint:string};
type EventRow={id:string;ticket_id:string;payload:Record<string,unknown>;sequence:string};
type FactRow={fact_key:string;value:unknown;verification_status:string};
type OfferingRow={offering_key:string;label:string;description:string;
  amount:string;currency:string;revision:number;conditions:string|null};
type Base={kind:ProposalKind;id:string;payload:ProposalPayload};

const field=(facts:Map<string,unknown>,keys:string[]):string=>{
  for(const key of keys){
    const value=facts.get(key);
    if(typeof value==="string" && value.trim())return value.trim();
  }
  return "";
};
const count=(value:unknown,min:number,max:number):number|null=>{
  const n=typeof value==="number"?value:
    typeof value==="string"&&/^\d+$/.test(value)?Number(value):NaN;
  return Number.isSafeInteger(n)&&n>=min&&n<=max?n:null;
};
const fingerprint=(data:unknown):string=>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
const canonical=(v:string):string=>v.trim()
  .replace(/^["“”']+|["“”']+$/g,"")
  .replace(/[.!]+$/g,"")
  .replace(/\s+/g," ").toLowerCase();
export const isLeadQuoteApproval=(s:string):boolean=>
  canonical(s)===canonical(LEAD_QUOTE_APPROVAL) ||
  canonical(s)===canonical("Yes, "+LEAD_QUOTE_APPROVAL);
export const isPurchasePaymentApproval=(s:string):boolean=>
  canonical(s)===canonical(PURCHASE_PAYMENT_APPROVAL) ||
  canonical(s)===canonical("Yes, "+PURCHASE_PAYMENT_APPROVAL);
/** A short affirmative reply is authorization only when the immediately
 * preceding assistant message displays exactly one server-created proposal.
 * Without that context it remains an ordinary conversational answer. */
export const isContextualApproval=(s:string):boolean=>
  /^(?:yes|yes please|yes, please|go ahead|i approve|i consent|approved|please proceed|proceed)$/i
    .test(canonical(s));

function proposalCopy(p:Base):string {
  if(p.kind==="lead_quote"){
    const x=p.payload.data as LeadQuoteData;
    return [
      "**Review your ANCFZ enquiry and quotation**",
      "Proposal reference: "+p.id,
      "Customer: "+x.lead.name+" | Company: "+x.lead.company,
      "Contact: "+x.lead.email+" | "+x.lead.phone,
      "Activity: "+x.lead.description.split(";")[0],
      "Selected package: "+x.offeringLabel,
      "Published test package total: "+x.currency+" "+x.amount+
        " for "+x.visaCount+" visa(s) and "+x.termYears+" year(s).",
      "Workspace requested: "+x.officePreference+
        ". This preference is not a priced inclusion unless the published package explicitly says so.",
      quoteDetailsMarkdown(x.proposal),
      "This is a non-binding test quotation. Licensing, visa issuance and activities"+
        " remain subject to authority approval. Full published scope and conditions"+
        " will be included in the independently generated quotation PDF.",
      "With your permission I will share the reviewed contact details with Salesforce"+
        " once, then prepare this exact quotation only after its lead is verified.",
      'To authorize these actions, reply: "'+LEAD_QUOTE_APPROVAL+'"',
    ].filter(Boolean).join("\n\n");
  }
  const x=p.payload.data as PurchaseData;
  return [
    "**Review your sandbox purchase and test payment**",
    "Proposal reference: "+p.id,
    "Quotation: "+x.quotationId+" | Amount: "+x.currency+" "+x.amount,
    "Billing name: "+x.billingName+" | Synthetic billing email: "+x.testEmail,
    "Your required test identity documents must already be validated. Authorizing will confirm this exact purchase and request a synthetic OTP; it will not pay automatically.",
    'To approve, reply: "'+PURCHASE_PAYMENT_APPROVAL+'"',
    "Enter the OTP through the secure chat input, never in a normal message. Card details belong only on the hosted sandbox checkout.",
  ].join("\n\n");
}
async function latestEvent(
  client:import("pg").PoolClient,agentId:string,ticketId:string,type:string,
):Promise<EventRow|null>{
  const r=await client.query<EventRow>(
    "SELECT id,ticket_id,payload,sequence::text FROM ticket_events WHERE agent_id=$1 AND ticket_id=$2 AND event_type=$3 ORDER BY sequence DESC LIMIT 1",
    [agentId,ticketId,type],
  );
  return r.rows[0]??null;
}
function asProposal(row:EventRow|null):Base|null{
  if(!row||!row.payload||typeof row.payload!=="object")return null;
  const x=row.payload as Partial<ProposalPayload>;
  if((x.kind!=="lead_quote"&&x.kind!=="purchase_payment")||
    typeof x.fingerprint!=="string"||!x.data)return null;
  return {kind:x.kind,id:row.id,payload:x as ProposalPayload};
}
async function agentIsAncfz(client:import("pg").PoolClient,id:string):Promise<boolean>{
  const r=await client.query<{agent_key:string}>(
    "SELECT agent_key FROM agents WHERE id=$1 AND status='active'",[id]);
  return r.rows[0]?.agent_key==="ancfz";
}

export class ChatJourney {
  constructor(private readonly db:PersistenceDatabase){}

  /** No model can approve a side effect. Require the exact consent utterance,
   * a preceding assistant proposal containing the event ID, an unchanged
   * proposal, a verified ticket scope and a fresh customer source message. */
  async accept(scope:TicketScope,ticketId:string,sourceMessageId:string,text:string):
    Promise<"lead_quote"|"purchase_payment"|null>{
    const exactKind=isLeadQuoteApproval(text)?"lead_quote":
      isPurchasePaymentApproval(text)?"purchase_payment":null;
    if(!exactKind&&!isContextualApproval(text))return null;
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      if(!await agentIsAncfz(client,scope.agentId)){
        if(exactKind)throw new PersistenceError("CONFLICT","CHAT_APPROVAL_AGENT_INACTIVE");
        return null;
      }
      // Contextual assent is intentionally scoped to the most recent proposal
      // across both transaction types; never guess which operation was meant.
      const row=exactKind
        ?await latestEvent(client,scope.agentId,ticketId,"chat."+exactKind+".proposed")
        :(await client.query<EventRow>(
          "SELECT id,ticket_id,payload,sequence::text FROM ticket_events WHERE agent_id=$1 AND ticket_id=$2 AND event_type IN ('chat.lead_quote.proposed','chat.purchase_payment.proposed') ORDER BY sequence DESC LIMIT 1",
          [scope.agentId,ticketId],
        )).rows[0]??null;
      // Exact, scope-specific consent is unambiguous; a short "yes" is not.
      // Use finite denial codes to make failures diagnosable without logging
      // contact details, chat content, or proposal payloads.
      const denied=(code:string):null=>{
        if(exactKind)throw new PersistenceError("CONFLICT","CHAT_APPROVAL_"+code);
        return null;
      };
      const p=asProposal(row);
      if(!p || (exactKind&&p.kind!==exactKind))return denied("PROPOSAL_MISSING");
      const kind=p.kind;
      const source=await client.query<{id:string;message_sequence:string}>(
        "SELECT id,message_sequence::text FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND role='customer'",
        [scope.agentId,ticketId,sourceMessageId],
      );
      const customer=source.rows[0];
      if(!customer)return denied("SOURCE_MISSING");
      // Match a *displayed* server-authored proposal, rather than assuming
      // the last two messages are always customer + proposal. Asynchronous
      // verified lifecycle notices may be inserted between those messages.
      const visible=await client.query<{id:string;content:string;message_sequence:string}>(
        "SELECT id,content,message_sequence::text FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND role='assistant' AND message_sequence<$3::bigint AND position($4 IN content)>0 AND position($5 IN content)>0 ORDER BY message_sequence DESC LIMIT 1",
        [scope.agentId,ticketId,customer.message_sequence,
          "Proposal reference: "+p.id,
          kind==="lead_quote"?LEAD_QUOTE_APPROVAL:PURCHASE_PAYMENT_APPROVAL],
      );
      const displayed=visible.rows[0];
      if(!displayed)return denied("NOT_DISPLAYED");
      const intervening=await client.query<{role:string;content:string}>(
        "SELECT role,content FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND message_sequence>$3::bigint AND message_sequence<$4::bigint ORDER BY message_sequence",
        [scope.agentId,ticketId,displayed.message_sequence,customer.message_sequence],
      );
      // No customer can amend the proposal or ask an unrelated question
      // between proposal display and approval. For contextual short assent,
      // even an intervening assistant notice makes "yes" ambiguous.
      if(intervening.rows.some(m=>m.role==="customer"))
        return denied("CUSTOMER_INTERVENED");
      if(intervening.rows.some(m=>m.role==="assistant"&&
        (isContextualApproval(text)||m.content.includes("Proposal reference: "))))
        return denied("AMBIGUOUS_ASSISTANT");
      const previous=await latestEvent(client,scope.agentId,ticketId,"chat."+kind+".consented");
      if(previous && previous.payload.proposalId===p.id)return kind;
      // Prevent acceptance of an expired proposal after facts, price, or
      // quotation changed. The sequenced next customer message must be approval.
      if(kind==="lead_quote"){
        const fresh=await this.leadQuoteData(client,scope.agentId,ticketId);
        if(!fresh)
          throw new PersistenceError("CONFLICT","CHAT_APPROVAL_SNAPSHOT_UNAVAILABLE");
        if(fingerprint(fresh)!==p.payload.fingerprint)
          throw new PersistenceError("CONFLICT","CHAT_APPROVAL_SNAPSHOT_CHANGED");
      }else{
        const x=p.payload.data as PurchaseData;
        const q=await client.query<{amount:string;currency:string;state:string}>(
          "SELECT q.amount::text,q.currency,op.state FROM ticket_quotations q JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.id=q.operation_id WHERE q.agent_id=$1 AND q.ticket_id=$2 AND q.id=$3",
          [scope.agentId,ticketId,x.quotationId]);
        if(q.rows[0]?.state!=="verified_completed"||
           q.rows[0].amount!==x.amount||q.rows[0].currency.trim()!==x.currency)
          throw new PersistenceError("CONFLICT","The quotation changed; purchase consent is no longer valid");
      }
      await appendEventTx(client,scope.agentId,ticketId,"chat."+kind+".consented",{
        proposalId:p.id,sourceMessageId,consentText:kind==="lead_quote"?
          LEAD_QUOTE_APPROVAL:PURCHASE_PAYMENT_APPROVAL,
      });
      return kind;
    });
  }

  private async leadQuoteData(client:import("pg").PoolClient,agentId:string,ticketId:string):
    Promise<LeadQuoteData|null>{
    const intent=await client.query<{intent_key:string;allowed_actions:string[]}>(
      "SELECT i.intent_key,i.allowed_actions FROM tickets t JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active' JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id AND i.catalog_version_id=t.intent_catalog_version_id WHERE t.agent_id=$1 AND t.id=$2 AND t.status<>'closed' LIMIT 1",
      [agentId,ticketId],
    );
    const current=intent.rows[0];
    if(!current||!current.allowed_actions.includes("create_lead")||
       !current.allowed_actions.includes("generate_quote"))return null;
    const rows=await client.query<FactRow>(
      "SELECT fact_key,value,verification_status FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2",
      [agentId,ticketId],
    );
    const f=new Map(rows.rows.filter(x=>x.verification_status!=="disputed")
      .map(x=>[x.fact_key,x.value] as [string,unknown]));
    // A complete contact/price snapshot is not enough: the existing Node
    // Lead and Quote services also enforce catalog prerequisites. Check them
    // before offering consent, otherwise a customer can approve an action
    // that the worker will only reject after approval.
    const requirements=await client.query<{requirement_key:string}>(
      "SELECT DISTINCT r.requirement_key FROM tickets t JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active' JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id AND i.catalog_version_id=t.intent_catalog_version_id JOIN intent_requirements r ON r.agent_id=i.agent_id AND r.intent_id=i.id WHERE t.agent_id=$1 AND t.id=$2 AND r.required_for && ARRAY['create_lead','generate_quote']::text[]",
      [agentId,ticketId],
    );
    if(requirements.rows.some(r=>{
      const value=f.get(r.requirement_key);
      return value===undefined||value===null||
        (typeof value==="string"&&!value.trim())||
        (typeof value==="number"&&!Number.isFinite(value));
    }))return null;
    const name=field(f,["customer_name"]);
    const company=field(f,["preferred_company_name","company_name"]);
    const phone=field(f,["customer_phone"]);
    const email=field(f,["customer_email","email"]);
    const activity=field(f,["business_activity"]);
    const officePreference=field(f,["office_preference"]);
    const visaCount=count(f.get("visa_count"),0,10);
    const termYears=count(f.get("term_years"),1,5);
    // A first name is enough for chat, but not for Salesforce lead dispatch.
    // Do not issue a consent proposal that the n8n workflow would reject.
    if(!parseSalesforceLeadName(name)||!company||!phone||!email||!activity||!officePreference||
      visaCount===null||termYears===null)return null;
    // The conversational tool and transactional proposal MUST agree about
    // valid contact metadata. Do not issue a proposal for a phone missing a
    // country code merely because the old Salesforce regex would accept it.
    const validatedPhone=normalizeContactPhone(phone);
    const validatedEmail=validateConversationFact("customer_email",email,"email");
    if(validatedPhone.status!=="accepted"||validatedEmail.status!=="accepted")
      return null;
    const key="visa_"+visaCount+"_y"+termYears;
    const option=await client.query<OfferingRow>(
      "SELECT o.offering_key,o.label,o.description,p.amount::text,p.currency,p.revision,p.conditions FROM tickets t JOIN offering_catalog_versions cv ON cv.agent_id=t.agent_id AND cv.id=t.offering_catalog_version_id AND cv.status IN ('published','retired') JOIN offerings o ON o.agent_id=t.agent_id AND o.catalog_version_id=cv.id JOIN LATERAL (SELECT pr.currency,pr.amount,pr.revision,pr.conditions FROM offering_price_revisions pr WHERE pr.agent_id=o.agent_id AND pr.offering_id=o.id AND pr.effective_from<=now() AND (pr.effective_to IS NULL OR pr.effective_to>now()) ORDER BY pr.revision DESC LIMIT 1) p ON true WHERE t.agent_id=$1 AND t.id=$2 AND o.offering_key=$3 AND (o.intent_key=$4 OR ($4 IN ('quotation_request','package_comparison') AND o.intent_key IN ('company_formation','package_comparison'))) LIMIT 1",
      [agentId,ticketId,key,current.intent_key],
    );
    const price=option.rows[0];
    if(!price||!Number.isFinite(Number(price.amount))||Number(price.amount)<=0)return null;
    const description=[activity,"Visa count: "+visaCount,"Term years: "+termYears,
      "Office requested: "+officePreference].join("; ").slice(0,4000);
    const requirementsSnapshot=await quoteRequirementsTx(client,agentId,ticketId);
    return {lead:{name,company,phone:String(validatedPhone.value),
      email:String(validatedEmail.value),description},
      offeringKey:key,offeringLabel:price.label,priceRevision:price.revision,
      amount:price.amount,currency:price.currency.trim(),
      visaCount,termYears,officePreference,conditions:price.conditions,
      proposal:quoteDetails(price.description,requirementsSnapshot,price.conditions)};
  }

  private async stage(scope:TicketScope,ticketId:string,kind:ProposalKind,
    data:LeadQuoteData|PurchaseData):Promise<string>{
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const prior=asProposal(await latestEvent(client,scope.agentId,ticketId,
        "chat."+kind+".proposed"));
      const digest=fingerprint(data);
      // Do not re-offer an already authorized proposal, or create duplicates
      // merely because another ordinary chat message was sent.
      const approved=await latestEvent(client,scope.agentId,ticketId,"chat."+kind+".consented");
      if(approved&&prior&&approved.payload.proposalId===prior.id)
        throw new PersistenceError("CONFLICT","An authorized operation already exists in this ticket");
      if(prior?.payload.fingerprint===digest)return proposalCopy(prior);
      const created=await appendEventTx(client,scope.agentId,ticketId,
        "chat."+kind+".proposed",{kind,data,fingerprint:digest});
      return proposalCopy({kind,id:created.id,payload:{kind,data,fingerprint:digest}});
    });
  }

  /** Called after the model has saved source-linked facts, before the assistant
   * reply commits. It may replace a UI-form handoff with an exact proposal. */
  async prepare(scope:TicketScope,ticketId:string,requested:string|null):
    Promise<string|null>{
    if(!requested)return null;
    if(!["create_lead","generate_quote","purchase_quotation","invoice"].includes(requested))return null;
    const active=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      return agentIsAncfz(client,scope.agentId);
    });
    if(!active)return null;
    const quote=await new QuotationOperations(this.db).get(scope,ticketId);
    if(!quote && (requested==="create_lead"||requested==="generate_quote")){
      const approved=await this.db.withAgent(scope.agentId,async client=>
        latestEvent(client,scope.agentId,ticketId,"chat.lead_quote.consented"));
      if(approved)return null;
      const leads=await new LeadOperations(this.db).list(scope,ticketId);
      if(leads.some(l=>l.operation==="ancfz_salesforce_lead"))return null;
      const data=await this.db.withAgent(scope.agentId,async client=>
        this.leadQuoteData(client,scope.agentId,ticketId));
      if(!leadDispatchEnabled()||!quoteDispatchEnabled())
        return "Salesforce or quotation generation is temporarily unavailable. I can collect the details, but no external enquiry or PDF will be submitted.";
      // Missing/invalid facts are exposed as structured Node readiness to the
      // Foundry conversation. Never replace a model turn with a fixed form field.
      if(!data)return null;
      return this.stage(scope,ticketId,"lead_quote",data);
    }
    if(!quote||quote.state!=="verified_completed"||!quote.pdfAvailable||
       (requested!=="purchase_quotation"&&requested!=="invoice"))return null;
    if(!paymentEnabled())
      return "Sandbox payments are disabled. Your verified quotation remains available; no payment order or invoice has been created.";
    const purchase=await new PurchaseOperations(this.db).read(scope,ticketId);
    const eligiblePurchase=await this.db.withAgent(scope.agentId,async client=>{
      const r=await client.query<{actions:string[]}>(
        "SELECT i.allowed_actions AS actions FROM tickets t JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active' JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id AND i.catalog_version_id=t.intent_catalog_version_id WHERE t.agent_id=$1 AND t.id=$2 LIMIT 1",
        [scope.agentId,ticketId]);
      return r.rows[0]?.actions.includes("purchase_quotation")===true;
    });
    if(!eligiblePurchase||!purchase.supported||purchase.confirmed||purchase.missing.length||
       !purchase.quotationId||!purchase.amount||purchase.currency!=="AED"||
       !purchase.billingName)return null;
    // Reuse the customer contact already supplied during the enquiry.
    // A sandbox-only alias uses the same local part but never a real domain.
    // The exact alias is displayed in the purchase consent proposal so the
    // customer can review/confirm it; never ask for their address again.
    const testEmail=await this.db.withAgent(scope.agentId,async client=>{
      const r=await client.query<{fact_key:string;value:unknown;verification_status:string}>(
        "SELECT fact_key,value,verification_status FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2 AND fact_key IN ('customer_test_email','customer_email','email')",
        [scope.agentId,ticketId]);
      const accepted=new Map(r.rows.filter(x=>x.verification_status!=="disputed"&&typeof x.value==="string")
        .map(x=>[x.fact_key,String(x.value).trim().toLowerCase()]));
      const prior=accepted.get("customer_test_email");
      if(prior&&/^[A-Za-z0-9._%+-]+@example\.invalid$/i.test(prior))return prior;
      const contact=accepted.get("customer_email")??accepted.get("email")??"";
      if(validateConversationFact("customer_email",contact,"email").status!=="accepted")
        return "";
      const local=contact.split("@")[0]!.slice(0,64).replace(/[^a-z0-9._%+-]/gi,"");
      return local?local+"@example.invalid":"";
    });
    if(!testEmail)
      return "I cannot locate a valid contact email in our conversation. Please confirm the email already supplied so I can prepare the sandbox review.";
    return this.stage(scope,ticketId,"purchase_payment",{
      quotationId:purchase.quotationId,amount:purchase.amount,currency:purchase.currency,
      billingName:purchase.billingName,testEmail,
    });
  }

  /** A completed secure upload advances to a PURCHASE REVIEW, never consent.
   * This Node-authored assistant message is persisted and sent over the existing
   * ticket stream. It is not a fabricated customer chat turn or an order dispatch.
   */
  async afterDocumentsReceived(
    scope:TicketScope,ticketId:string,sourceDocumentId:string|null=null,
  ):Promise<boolean>{
    if(sourceDocumentId!==null)requireUuid(sourceDocumentId,"sourceDocumentId");
    const purchase=await new PurchaseOperations(this.db).read(scope,ticketId);
    if(!purchase.supported||purchase.confirmed||purchase.missing.length||
       !purchase.billingName||!purchase.quotationId)return false;
    const quote=await new QuotationOperations(this.db).get(scope,ticketId);
    if(!quote||quote.state!=="verified_completed"||!quote.pdfAvailable||
       quote.id!==purchase.quotationId)return false;

    // A stable quote-scoped message key makes this safe to trigger both from
    // the final upload and from a refreshed, already-complete document panel.
    // Never re-offer the initial review automatically after it was displayed.
    const noticeId=lifecycleNoticeId("purchase.review.ready",purchase.quotationId);
    const alreadyDisplayed=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const r=await client.query(
        "SELECT 1 FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND role='assistant' AND request_id=$3 LIMIT 1",
        [scope.agentId,ticketId,noticeId]);
      return (r.rowCount??r.rows.length)>0;
    });
    if(alreadyDisplayed)return false;

    // The action cursor must survive refresh and the next customer's billing
    // email answer. Uploads are not approvals; the separate quoted purchase
    // proposal still requires an exact, displayed conversational consent.
    await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      return appendEventTx(client,scope.agentId,ticketId,"purchase.review.started",{
        actionKey:"purchase_quotation",sourceDocumentId,
        quotationId:purchase.quotationId,
      });
    });
    const review=await this.prepare(scope,ticketId,"purchase_quotation");
    if(!review)return false;
    await new TicketMessageRepository(this.db).createAssistantMessage(
      scope,ticketId,noticeId,
      review,[],
    );
    return true;
  }

  /** Safe background convergence from durable authorization to independently
   * verified provider operations. No uncertain POST is ever re-dispatched. */
  async advance(log:(data:Record<string,unknown>,message:string)=>void):Promise<void>{
    const agents=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active'");
    for(const {id:agentId} of agents.rows){
      const approvals=await this.db.withAgent(agentId,async client=>{
        const r=await client.query<{ticket_id:string;proposal_id:string;kind:ProposalKind;proposal:ProposalPayload}>(
          "SELECT a.ticket_id,p.id AS proposal_id,p.payload->>'kind' AS kind,p.payload AS proposal FROM ticket_events a JOIN ticket_events p ON p.agent_id=a.agent_id AND p.ticket_id=a.ticket_id AND p.id=(a.payload->>'proposalId')::uuid JOIN tickets t ON t.agent_id=a.agent_id AND t.id=a.ticket_id WHERE a.agent_id=$1 AND a.event_type IN ('chat.lead_quote.consented','chat.purchase_payment.consented') AND t.status<>'closed' ORDER BY a.created_at DESC LIMIT 100",
          [agentId],
        );
        return r.rows;
      });
      for(const item of approvals){
        const scope=workerTicketScope(agentId,item.ticket_id);
        let paymentPhase:string|null=null;
        try{
          if(item.kind==="lead_quote"){
            const x=item.proposal.data as LeadQuoteData;
            const current=await this.db.withAgent(agentId,async client=>
              this.leadQuoteData(client,agentId,item.ticket_id));
            if(!current||fingerprint(current)!==item.proposal.fingerprint)
              continue; // Never submit a stale chat proposal after corrections.
            const leads=await new LeadOperations(this.db).list(scope,item.ticket_id);
            const lead=leads.find(l=>l.operation==="ancfz_salesforce_lead");
            if(!lead){
              if(!leadDispatchEnabled())continue;
              await new LeadOperations(this.db).submit(scope,item.ticket_id,{
                requestId:item.proposal_id,...x.lead,consent:true,consentText:LEAD_CONSENT_TEXT,
              });
              continue;
            }
            if(lead.state!=="verified_completed")continue;
            if(await new QuotationOperations(this.db).get(scope,item.ticket_id))continue;
            if(!quoteDispatchEnabled())continue;
            const options=await new QuotationOperations(this.db).options(scope,item.ticket_id);
            const matched=options.options.find(o=>o.offeringKey===x.offeringKey&&
              o.priceRevision===x.priceRevision&&o.amount===x.amount&&o.currency===x.currency);
            if(!matched)continue; // Do not substitute another price or first SKU.
            await new QuotationOperations(this.db).submit(scope,item.ticket_id,{
              requestId:item.proposal_id,customerName:x.lead.name,
              offeringKey:x.offeringKey,acknowledged:true,
              acknowledgmentText:QUOTATION_ACKNOWLEDGMENT,
            },{amount:x.amount,currency:x.currency,priceRevision:x.priceRevision});
            continue;
          }
          if(item.kind==="purchase_payment"){
            paymentPhase="purchase_read";
            const x=item.proposal.data as PurchaseData;
            const purchase=await new PurchaseOperations(this.db).read(scope,item.ticket_id);
            if(!purchase.confirmed){
              paymentPhase="purchase_confirm";
              await new PurchaseOperations(this.db).confirm(scope,item.ticket_id,{
                requestId:item.proposal_id,quotationId:x.quotationId,amount:x.amount,
                currency:x.currency,consent:true,consentText:PURCHASE_CONSENT,
              });
            }
            if(!paymentEnabled())continue;
            paymentPhase="otp_input_preflight";
            const firstName=x.billingName.trim().split(/\s+/)[0]??"";
            const otpRequest={
              requestId:item.proposal_id,quotationId:x.quotationId,
              acceptedAmount:x.amount,currency:x.currency,
              email:x.testEmail,firstName,countryCode:"AE",
              consent:true,consentText:PAYMENT_CONSENT,
            };
            // Reject malformed OCR names or billing facts BEFORE committing
            // the one-shot dispatch marker. A failed preflight never calls n8n.
            parseStartOtp(otpRequest);
            // An OTP row is committed BEFORE the external mock-delivery POST.
            // Therefore, if an old dispatch marker has NO OTP row, dispatch
            // cannot have happened: a bounded, cooled-down retry is safe.
            // An existing OTP row (including failed/expired) is never replayed.
            paymentPhase="otp_claim";
            const started=await this.db.withAgent(agentId,async client=>{
              await authorizedTicket(client,scope,item.ticket_id,true);
              const existing=await client.query(
                "SELECT 1 FROM ticket_payment_otps WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3 LIMIT 1",
                [agentId,item.ticket_id,x.quotationId]);
              if(existing.rows.length)return true;
              const earlier=await latestEvent(client,agentId,item.ticket_id,"chat.otp.dispatch_started");
              if(earlier){
                if(earlier.payload.quotationId!==x.quotationId)return true;
                const retries=await client.query<{attempts:number;ready:boolean}>(
                  `SELECT count(*)::int AS attempts,
                      COALESCE(max(created_at)<now()-interval '90 seconds',false) AS ready
                     FROM ticket_events
                     WHERE agent_id=$1 AND ticket_id=$2
                       AND event_type IN ('chat.otp.dispatch_started','chat.otp.preinsert_retry_started')
                       AND payload->>'quotationId'=$3`,
                  [agentId,item.ticket_id,x.quotationId],
                );
                const state=retries.rows[0];
                // One further no-row recovery is permitted for tickets that
                // exhausted the previous budget against the unauthorized
                // quotation lock (fixed by the current payment preflight).
                // Still bounded and serialized; no existing OTP is replayed.
                if(!state?.ready||state.attempts>=4)return true;
                await appendEventTx(client,agentId,item.ticket_id,
                  "chat.otp.preinsert_retry_started",{
                    quotationId:x.quotationId,proposalId:item.proposal_id,
                    attempt:state.attempts,
                  });
                return false;
              }
              await appendEventTx(client,agentId,item.ticket_id,"chat.otp.dispatch_started",{
                quotationId:x.quotationId,proposalId:item.proposal_id,
              });
              return false;
            });
            if(started)continue;
            paymentPhase="otp_issue";
            await new PaymentOperations(this.db).issueOtp(scope,item.ticket_id,otpRequest);
            // Only status/challenge ID is exposed to the browser; code stays
            // exclusively in n8n's private mock table and an HMAC in Node.
            try {
              await new TicketMessageRepository(this.db).createAssistantMessage(
                scope,item.ticket_id,lifecycleNoticeId("otp.mock_recorded",item.proposal_id),
                "Your synthetic test OTP has been recorded privately. "+
                "Enter it using the secure code input in this chat (not a normal message). "+
                "It expires after five minutes; no payment has been made.",[],
              );
            } catch { /* Dispatch remains authoritative if chat notice fails. */ }
            log({ticketId:item.ticket_id},"Synthetic OTP recorded for secure in-chat entry");
          }
        }catch(error){
          // Finite classifications only: never log billing names, email, OTP
          // contents, source documents or arbitrary database error messages.
          const reasons:Record<string,string>={
            "Invalid synthetic billing identity or accepted quote":"INVALID_OTP_INPUT",
            "Verified quotation PDF is required before payment":"QUOTE_NOT_VERIFIED",
            "Select a purchase-enabled intent and obtain a verified quotation":"PURCHASE_NOT_ELIGIBLE",
            "Customer purchase confirmation is required before OTP":"PURCHASE_NOT_CONFIRMED",
            "Both ID documents must be read before purchase":"IDENTITY_DOCUMENTS_NOT_READY",
            "Passport and Emirates ID holder names differ; request review":"IDENTITY_MISMATCH",
            "OTP request rate limit; retry after cooldown":"OTP_RATE_LIMIT",
            "Test OTP could not be recorded. No payment is authorized":"OTP_DELIVERY_FAILED",
            "Persistence constraint rejected the operation":"PERSISTENCE_CONSTRAINT",
            "Database operation failed":"DATABASE_ERROR",
          };
          const reason=error instanceof PersistenceError
            ?reasons[error.message]??error.code:"UNEXPECTED";
          // A five-character SQLSTATE is safe operational metadata. Never
          // include the raw PG exception, parameters, SQL text or credentials.
          const cause=error instanceof PersistenceError?error.cause:null;
          const rawState=cause && typeof cause==="object" && "code" in cause
            ?cause.code:null;
          const sqlState=typeof rawState==="string" && /^[A-Z0-9]{5}$/.test(rawState)
            ?rawState:null;
          log({ticketId:item.ticket_id,code:(error as Error).name,
            ...(item.kind==="purchase_payment"?{
              reason,phase:paymentPhase,...(sqlState?{sqlState}:{}),
            }:{}),
          },"Chat-authorized workflow paused; preserve provider/idempotency state");
        }
      }
    }
  }

  /** Ticket-owner-only status for secure inline chat controls. No OTP values,
   * private document bytes or internal provider credentials are returned. */
  async status(scope:TicketScope,ticketId:string){
    requireUuid(ticketId,"ticketId");
    const lead=(await new LeadOperations(this.db).list(scope,ticketId))
      .find(l=>l.operation==="ancfz_salesforce_lead")??null;
    const quote=await new QuotationOperations(this.db).get(scope,ticketId);
    const purchase=await new PurchaseOperations(this.db).read(scope,ticketId);
    const payment=paymentReadEnabled()?await new PaymentOperations(this.db).get(scope,ticketId):null;
    const quoteConfirmation=quote?.id && quote.state==="verified_completed" && quote.pdfAvailable
      ?await new QuotationConfirmationOperations(this.db).read(scope,ticketId,quote.id):null;
    const challenge=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const r=await client.query<{id:string;quotation_id:string;state:string;expires_at:Date}>(
        "SELECT id,quotation_id,state,expires_at FROM ticket_payment_otps WHERE agent_id=$1 AND ticket_id=$2 ORDER BY created_at DESC LIMIT 1",
        [scope.agentId,ticketId]);
      const x=r.rows[0];return x?{
        challengeId:x.id,quotationId:x.quotation_id,state:x.state,
        expiresAt:x.expires_at.toISOString(),
      }:null;
    });
    const reviewIssued=quote?.id?await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const noticeId=lifecycleNoticeId("purchase.review.ready",quote.id);
      const r=await client.query(
        "SELECT 1 FROM ticket_messages WHERE agent_id=$1 AND ticket_id=$2 AND role='assistant' AND request_id=$3 LIMIT 1",
        [scope.agentId,ticketId,noticeId]);
      return (r.rowCount??r.rows.length)>0;
    }):false;
    return {lead,quotation:quote,purchase:{
      supported:purchase.supported,quotationId:purchase.quotationId,
      amount:purchase.amount,currency:purchase.currency,
      documents:purchase.requirements.map(x=>({key:x.key,label:x.label,required:x.required,
        uploaded:x.uploaded,status:x.status})),
      missing:purchase.missing,confirmed:purchase.confirmed,readyForOtp:purchase.readyForOtp,
      reviewIssued,
    },otp:challenge,payment,quoteConfirmation};
  }

  /** OTP stays outside chat messages and Foundry. Prior conversational
   * purchase/payment consent must match the exact quotation. */
  async verifySecureOtp(scope:TicketScope,ticketId:string,raw:unknown){
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Secure OTP input required");
    const x=raw as Record<string,unknown>;
    if(Object.keys(x).some(k=>!["requestId","challengeId","code"].includes(k))||
       typeof x.requestId!=="string"||typeof x.challengeId!=="string"||
       typeof x.code!=="string"||!/^\d{6}$/.test(x.code))
      throw new PersistenceError("INVALID_INPUT","Invalid secure OTP input");
    requireUuid(x.requestId,"requestId");requireUuid(x.challengeId,"challengeId");
    const approval=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const accepted=await latestEvent(client,scope.agentId,ticketId,"chat.purchase_payment.consented");
      if(!accepted)return null;
      const p=await client.query<{payload:ProposalPayload}>(
        "SELECT payload FROM ticket_events WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND event_type='chat.purchase_payment.proposed'",
        [scope.agentId,ticketId,accepted.payload.proposalId]);
      const data=p.rows[0]?.payload?.data as PurchaseData|undefined;
      const otp=await client.query<{quotation_id:string}>(
        "SELECT quotation_id FROM ticket_payment_otps WHERE agent_id=$1 AND ticket_id=$2 AND id=$3",
        [scope.agentId,ticketId,x.challengeId]);
      return data&&otp.rows[0]?.quotation_id===data.quotationId?data:null;
    });
    if(!approval)throw new PersistenceError("CONFLICT","Chat purchase authorization is required before OTP verification");
    return new PaymentOperations(this.db).authorize(scope,ticketId,{
      requestId:x.requestId,quotationId:approval.quotationId,
      challengeId:x.challengeId,code:x.code,consent:true,consentText:PAYMENT_CONSENT,
    });
  }
}

/** One in-process converger. Each operation remains idempotent in PostgreSQL,
 * so restarts cannot replay ambiguous provider POSTs. */
export class ChatJourneyDispatcher {
  private timer:ReturnType<typeof setInterval>|undefined;
  private busy=false;
  private stopped=false;
  constructor(private readonly journey:ChatJourney,
    private readonly log:(data:Record<string,unknown>,message:string)=>void){}
  start():void {
    this.timer=setInterval(()=>{void this.tick();},3000);
    this.timer.unref();
    void this.tick();
  }
  stop():void {
    this.stopped=true;
    if(this.timer)clearInterval(this.timer);
  }
  private async tick():Promise<void> {
    if(this.busy||this.stopped)return;
    this.busy=true;
    try {await this.journey.advance(this.log);}
    catch(error){
      this.log({code:(error as Error).name},"Chat journey dispatch sweep postponed");
    } finally {this.busy=false;}
  }
}
