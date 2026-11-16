/**
 * Minimal, durable handoff from an open-ended Foundry conversation to existing
 * customer-authorized Node business actions. This is NOT an action executor.
 *
 * Every fact, operation and readiness decision comes from ticket-scoped
 * PostgreSQL; a customer request is never interpreted as action consent.
 */
import { PersistenceDatabase } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { authorizedTicket, type TicketScope } from "../repositories/types.js";
import { IntentActionOperations } from "./intent-action-operations.js";
import { LeadOperations, leadDispatchEnabled } from "./lead-operations.js";
import { QuotationOperations, quoteDispatchEnabled } from "./quotation-operations.js";
import { PurchaseOperations } from "./purchase-operations.js";
import { PaymentOperations } from "./payment-operations.js";
import { paymentEnabled } from "./payment-evidence.js";

export type RequestedBusinessAction="create_lead"|"generate_quote"|"purchase_quotation"|"invoice";
export type HandoffStep={
  stage:string;
  response:string;
  missingCount:number;
};

const ACTION_EVENT="customer.action.requested";
const STOP_EVENT="customer.action.cancelled";

/** Detect explicit requests, not casual questions about business procedures. */
export function requestedBusinessAction(
  message:string,previous:RequestedBusinessAction|null=null,quotePdfSupported=false,
):RequestedBusinessAction|null {
  const text=message.trim().toLowerCase();
  // "How can I get a quotation?" is a question about the process, not
  // authorization or even a request to start a formal quote.
  const informational=/\b(?:explain|understand|meaning|definition|requirements?|documents|procedure|process|steps|options|information|overview|tell me|want to know)\b/i;
  const explicitSubmission=/\b(?:send|share|prepare|generate|create|produce|issue|submit|download)\b/i;
  if(/^(?:what|why|how|when|where|which)\b/i.test(text))return null;
  if(informational.test(text) && !explicitSubmission.test(text))return null;
  const request=/(?:\b(?:send|share|prepare|generate|create|produce|request|provide|give|issue|make|download|get|want|need)\b|\b(?:can|could|would) (?:you|i|we)\b|\bi(?:'d| would) like\b)/i;
  if(!request.test(text))return null;
  if(/\b(?:invoice|receipt)\b/i.test(text))return "invoice";
  if(/\b(?:quotation|quote)\b/i.test(text))return "generate_quote";
  if(/\bpdf\b/i.test(text) &&
    (previous==="generate_quote" || (quotePdfSupported &&
      !/\b(?:source|reference|policy|regulation|requirements?|steps|procedure|knowledge article|passport)\b/i.test(text))))
    return "generate_quote";
  if(/\b(?:checkout|purchase|buy|pay(?:ment)?)\b/i.test(text))return "purchase_quotation";
  if(/\b(?:salesforce lead|crm lead|salesforce follow.up)\b/i.test(text))return "create_lead";
  return null;
}

export function nextQuestion(missing:readonly {key:string;label:string}[]):string|null {
  const order=[
    "business_activity","preferred_company_name","shareholder_nationality",
    "customer_email","shareholder_count","visa_count","term_years","office_preference",
  ];
  const ranked=[...missing].sort((a,b)=>{
    const idx=(key:string)=>order.includes(key)?order.indexOf(key):order.length;
    return idx(a.key)-idx(b.key) || a.key.localeCompare(b.key);
  });
  const first=ranked[0];
  if(!first)return null;
  const questions:Record<string,string>={
    business_activity:"What business activity will your company carry out?",
    preferred_company_name:"What company name would you like to register?",
    shareholder_nationality:"What is the shareholder's nationality?",
    customer_email:"What email address should ANCFZ use for your enquiry?",
    shareholder_count:"How many shareholders will the company have?",
    visa_count:"How many visas will you need?",
    term_years:"Would you prefer a one-year, two-year or longer package?",
    office_preference:"Which workspace would you prefer: flexi-desk, shared office or private office?",
  };
  return questions[first.key]??(first.label.trim().endsWith("?")
    ?first.label.trim():"Could you tell me "+first.label.trim().replace(/[.?]+$/,"").toLowerCase()+"?");
}

type Action={actionKey:string;kind:string;ready:boolean;missing:string[];
  requirements:{key:string;label:string;present:boolean}[]};
function missingFor(action:Action):{key:string;label:string}[] {
  return action.requirements.filter(r=>!r.present&&action.missing.includes(r.key))
    .map(r=>({key:r.key,label:r.label}));
}
function step(stage:string,response:string,missingCount=0):HandoffStep {
  return {stage,response,missingCount};
}
const cancelled=/^(?:never mind|nevermind|stop|cancel(?: the (?:quote|quotation|request|application|purchase))?|forget (?:the|my) (?:quote|quotation|request|purchase))[.!\s]*$/i;

export class ConversationActionHandoff {
  constructor(private readonly db:PersistenceDatabase){}

  async current(scope:TicketScope,ticketId:string):Promise<RequestedBusinessAction|null> {
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const result=await client.query<{event_type:string;payload:{actionKey?:string}}>(
        `SELECT event_type,payload FROM ticket_events WHERE agent_id=$1 AND ticket_id=$2
         AND event_type IN ($3,$4) ORDER BY sequence DESC LIMIT 1`,
        [scope.agentId,ticketId,ACTION_EVENT,STOP_EVENT],
      );
      const row=result.rows[0];
      if(!row||row.event_type===STOP_EVENT)return null;
      const action=row.payload?.actionKey;
      return action==="generate_quote"||action==="create_lead"||
        action==="purchase_quotation"||action==="invoice"?action:null;
    });
  }

  async observe(scope:TicketScope,ticketId:string,messageId:string,message:string):
    Promise<{action:RequestedBusinessAction|null;explicit:boolean}> {
    const previous=await this.current(scope,ticketId);
    let quotePdfSupported=false;
    // "Can you send me a PDF?" should mean a quotation when this ticket
    // offers quotations, even if the customer did not use the word "quote".
    if(!previous && /\bpdf\b/i.test(message)){
      const catalog=await new IntentActionOperations(this.db).catalog(scope,ticketId);
      quotePdfSupported=catalog.actions.some(a=>a.actionKey==="generate_quote");
    }
    const action=requestedBusinessAction(message,previous,quotePdfSupported);
    const stop=cancelled.test(message.trim());
    if(!action&&!stop)return {action:previous,explicit:false};
    const next=stop?null:action;
    if(next===previous)return {action:next,explicit:Boolean(action)};
    await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      await appendEventTx(client,scope.agentId,ticketId,next?ACTION_EVENT:STOP_EVENT,
        {sourceMessageId:messageId,...(next?{actionKey:next}:{})});
    });
    return {action:next,explicit:Boolean(action)};
  }

  async status(scope:TicketScope,ticketId:string,request:RequestedBusinessAction|null):
    Promise<HandoffStep|null> {
    if(!request)return null;
    const state=await new IntentActionOperations(this.db).catalog(scope,ticketId);
    if(!state.intentKey)return step("intent_needed",
      "I can help with that. Are you setting up a new company or requesting a service for an existing one?");
    const actions=state.actions as Action[];
    const lead=actions.find(a=>a.actionKey==="create_lead");
    const quotation=actions.find(a=>a.actionKey==="generate_quote");
    const purchase=actions.find(a=>a.actionKey==="purchase_quotation");
    if(!lead && request==="create_lead")return step("unsupported","This service doesn't have an authorized Salesforce enquiry action.");
    if(!quotation && request!=="create_lead")return step("unsupported","A formal quotation isn't configured for this service yet. I can still explain the available options.");

    // A formal quote is never issued before the customer authorizes a lead and
    // an independently verified Salesforce response exists.
    const leads=lead?await new LeadOperations(this.db).list(scope,ticketId):[];
    const leadState=leads.find(l=>l.operation==="ancfz_salesforce_lead")?.state??null;
    if(lead && leadState!=="verified_completed") {
      if(leadState==="unknown_outcome"||leadState==="terminal_failed")
        return step("lead_review","Your Salesforce enquiry needs staff review. I won't submit another one or issue a quotation until it is verified.");
      if(leadState==="queued"||leadState==="running")
        return step("lead_processing","Your Salesforce enquiry is being processed. Once it is verified, we can prepare the formal quotation.");
      const missing=missingFor(lead);
      if(missing.length){
        const q=nextQuestion(missing);
        return step("lead_facts",q??"What details should I use for your enquiry?",missing.length);
      }
      if(!leadDispatchEnabled())
        return step("lead_disabled","Salesforce enquiry submission is currently unavailable. Your details are saved, and no lead has been submitted.");
      return step("lead_consent","I have your enquiry details. I'll summarize the exact Salesforce contact-sharing and quotation proposal here in chat; please review it before authorizing.");
    }
    if(request==="create_lead")
      return step("lead_complete","Your Salesforce lead is verified. Would you like me to help prepare a formal quotation?");

    if(quotation) {
      const missing=missingFor(quotation);
      if(missing.length){
        const q=nextQuestion(missing);
        return step("quote_facts",q??"Which package details would you prefer?",missing.length);
      }
    }
    const quote=await new QuotationOperations(this.db).get(scope,ticketId);
    if(!quote) {
      if(!quoteDispatchEnabled())
        return step("quote_disabled","Formal quotation generation is temporarily unavailable. I can confirm your package details, but no PDF has been issued.");
      return step("quote_consent","Your details are ready. I'll present the matched published package, exact price and authorization here in the conversation.");
    }
    if(quote.state!=="verified_completed"||!quote.pdfAvailable) {
      if(quote.state==="unknown_outcome"||quote.state==="terminal_failed")
        return step("quote_review","Your quotation needs staff review before a PDF can be shared. I won't submit a duplicate request.");
      return step("quote_processing","Your quotation is being prepared. I'll let you know when the PDF is ready.");
    }
    if(request==="generate_quote")return step("quote_ready",
      "Your verified quotation PDF is available here in the conversation. Would you like to continue with the sandbox documents and test checkout?");
    if(!purchase)return step("purchase_unsupported",
      "The quotation is ready, but checkout isn't configured for this service.");

    const documents=await new PurchaseOperations(this.db).read(scope,ticketId);
    if(!documents.supported)
      return step("purchase_unsupported",
        "This quotation is not available for sandbox checkout. I can help review the next steps.");
    if(documents.missing.length){
      return step("documents_pending",
        "Before checkout, upload the required synthetic documents using the secure file controls shown inside this conversation. Never paste identity details into a normal chat message.",
        documents.missing.length);
    }
    if(!documents.confirmed)
      return step("purchase_consent",
        "Your synthetic documents are ready. I'll present the exact-amount sandbox purchase consent here in the conversation.");
    if(!documents.readyForOtp)
      return step("purchase_review",
        "Your sandbox purchase needs further verification; I will not issue an OTP until the secure document and approval checks pass.");
    if(!paymentEnabled())
      return step("payment_disabled",
        "Your purchase details are ready, but sandbox payment is currently unavailable. No payment has been processed.");
    const payments=await new PaymentOperations(this.db).get(scope,ticketId);
    const payment=payments.payments[0];
    if(!payment)return step("otp_pending",
      "Your approved sandbox purchase is being prepared. Enter the test OTP only in the secure code input displayed in this conversation, never in a normal message.");
    if(payment.state==="unknown_outcome"||payment.state==="payment_refunded"||
       payment.state==="payment_declined")
      return step("payment_review",
        "Your payment needs review. I can't confirm payment or issue an invoice from an unverified result.");
    if(payment.state!=="verified_test_payment")
      return step("payment_processing",
        "Your sandbox payment is being checked. I'll confirm it only after independent verification.");
    if(payments.invoice?.pdfAvailable)
      return step("invoice_ready",
        "Your sandbox payment is verified and your TEST invoice PDF is available in this conversation.");
    return step("invoice_processing",
      "Your sandbox payment is verified. Your test invoice is being prepared.");
  }
}

/** A short answer to a previously asked question should continue the user's
 * action request only when it actually updated persisted prerequisite facts.
 * Unrelated FAQs must still be answered naturally.
 */
export function shouldUseHandoff(
  message:string,explicit:boolean,before:HandoffStep|null,after:HandoffStep|null,
):boolean {
  if(!after)return false;
  if(explicit)return true;
  if(/\b(?:what next|what's next|next step|continue|proceed)\b/i.test(message))return true;
  if(before && after.missingCount<before.missingCount && !/\?/.test(message))return true;
  // If an answer did not persist, repeat the SAME authoritative missing
  // question instead of inventing a fact or pretending the stage advanced.
  return Boolean(before && /^(lead_facts|quote_facts)$/.test(before.stage)
    && /^(lead_facts|quote_facts)$/.test(after.stage)
    && !/\?/.test(message) && message.length<=150
    && !/^(?:thanks|thank you|hello|hi|okay|ok|bye|goodbye)[.! ]*$/i.test(message.trim()));
}
