import { FoundryClient } from "../foundry/client.js";
import { FoundryError } from "../foundry/errors.js";
import type { SourceReference as FoundryReference } from "../foundry/types.js";
import { AgentToolRegistry, type RegisteredToolName, type TrustedToolContext } from "../agent/tool-registry.js";
import { registerIntentTools } from "../agent/intent-tools.js";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { ConversationContextRepository } from "../repositories/context.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { scopedIntentToolRepositories } from "../repositories/intent-adapter.js";
import { workerTicketScope, type SourceReference } from "../repositories/types.js";
import { TurnQueue, type PendingTurn } from "./turn-queue.js";
import { PurchaseOperations } from "./purchase-operations.js";
import { PaymentOperations, isExplicitPaymentRetryRequest } from "./payment-operations.js";
import { IntentActionOperations } from "./intent-action-operations.js";
import { ConversationActionHandoff, shouldShowAuthoritativeStatus, isConversationContinuation } from "./conversation-action-handoff.js";
import { ChatJourney, isLeadQuoteApproval, isPurchasePaymentApproval } from "./chat-journey.js";
import { recoverSourcedAnswer } from "./chat-fact-reconciliation.js";
import { validateConversationFact, normalizeContactPhone } from "./fact-validation.js";
import { parseSalesforceLeadName } from "./lead-operations.js";

const ENABLED_TOOLS:ReadonlySet<RegisteredToolName>=new Set([
  "find_intents","select_ticket_intent","get_intent_requirements","record_ticket_facts","get_offerings",
]);

function citations(references:readonly FoundryReference[]):SourceReference[] {
  const out:SourceReference[]=[];
  const seen=new Set<string>();
  for(const ref of references) {
    let uri:string|null=null;
    let sourceId=ref.fileId?.trim() || "";
    if(ref.url) {
      try {
        const parsed=new URL(ref.url);
        const risky=parsed.protocol!=="https:" || /(^localhost$|\.internal$|\.local$|\.private$)/i.test(parsed.hostname) ||
          /(^|[?&])(sig|se|sp|sv|token|access_token)=/i.test(parsed.search) ||
          /(^|\.)blob\.core\.windows\.net$/i.test(parsed.hostname);
        if(!risky) uri=parsed.origin+parsed.pathname;
        if(!sourceId && parsed.protocol==="https:") sourceId=parsed.origin+parsed.pathname;
      } catch { /* Not a usable public reference. */ }
    }
    if(!sourceId || sourceId.length>512 || seen.has(sourceId)) continue;
    seen.add(sourceId);
    out.push({sourceId,...(ref.title||ref.filename?{title:(ref.title??ref.filename)?.slice(0,500)}:{}),
      ...(uri?{uri}:{}),});
    if(out.length===50) break;
  }
  return out;
}

function authorizedTools(config:Record<string,unknown>):ReadonlySet<RegisteredToolName> {
  const list=config["toolNames"];
  if(!Array.isArray(list)) return new Set();
  return new Set(list.filter((value):value is RegisteredToolName=>
    typeof value==="string"&&ENABLED_TOOLS.has(value as RegisteredToolName)));
}

export class TurnWorker {
  private tickInProgress=false;
  private active=0;
  // Ticket turns remain ordered by TurnQueue.claim; unrelated tickets can run concurrently.
  // Keep this deliberately small to cap Azure model calls and PostgreSQL pressure.
  private readonly concurrency=(()=>{
    const value=Number(process.env.FOUNDRY_TURN_CONCURRENCY ?? "1");
    return Number.isSafeInteger(value)&&value>=1&&value<=3?value:1;
  })();
  private stopped=false;
  private lastRecovery=0;
  private timer:ReturnType<typeof setInterval>|undefined;
  private readonly agents:AgentRepository;
  private readonly context:ConversationContextRepository;
  private readonly messages:TicketMessageRepository;

  constructor(private readonly db:PersistenceDatabase,private readonly queue:TurnQueue,
    private readonly log:(data:Record<string,unknown>,message:string)=>void) {
    this.agents=new AgentRepository(db);
    this.context=new ConversationContextRepository(db);
    this.messages=new TicketMessageRepository(db);
  }

  async start():Promise<void> {
    await this.queue.reconcileMissing();
    await this.queue.recoverAbandoned();
    this.timer=setInterval(()=>{void this.tick();},1250);
    this.timer.unref();
    void this.tick();
  }

  stop():void {
    this.stopped=true;
    if(this.timer) clearInterval(this.timer);
  }

  private async tick():Promise<void> {
    if(this.tickInProgress||this.stopped||this.active>=this.concurrency)return;
    this.tickInProgress=true;
    try {
      if(Date.now()-this.lastRecovery>30000) {
        await this.queue.reconcileMissing();
        await this.queue.recoverAbandoned();
        this.lastRecovery=Date.now();
      }
      while(!this.stopped && this.active<this.concurrency) {
        const turn=await this.queue.claim();
        if(!turn)break;
        this.active++;
        // Only the next ticket turn is claimed; the queue's SQL predicate
        // serializes each ticket's previous_response_id across worker slots.
        void this.process(turn).catch(error=>{
          this.log({errorCode:(error as Error).name,turnId:turn.id},"Unexpected turn worker error");
        }).finally(()=>{
          this.active--;
          if(!this.stopped)void this.tick();
        });
      }
    } catch(error) {
      this.log({errorCode:(error as Error).name},"Turn worker polling failed");
    } finally {this.tickInProgress=false;}
  }

  private async process(turn:PendingTurn):Promise<void> {
    const startedAt=Date.now();
    let providerCalls=0;
    let throttledCalls=0;
    let providerLatencyMs=0;
    try {
      const scope=workerTicketScope(turn.agentId,turn.ticketId);
      const binding=await this.agents.getPinnedForTicket(scope,turn.ticketId);
      if(!binding.intentCatalogRevision||!binding.offeringCatalogRevision) throw new Error("PINNED_CATALOG_MISSING");
      let stored=await this.context.read(scope,turn.ticketId);
      const text=await this.queue.currentCustomerMessage(turn);
      const chatJourney=new ChatJourney(this.db);
      // Consent is tied to a Node-authored, ticket-scoped proposal that was
      // actually displayed before this message. Model text alone cannot act.
      let acceptedChatAction:"lead_quote"|"purchase_payment"|null=null;
      let approvalFailure:string|null=null;
      try {
        acceptedChatAction=await chatJourney.accept(scope,turn.ticketId,turn.messageId,text);
      } catch(error) {
        // Never log consent text, contact fields, or the proposal snapshot.
        // Finite denial codes distinguish stale facts from missing displayed
        // proposals; unexpected database errors remain generic.
        approvalFailure=error instanceof PersistenceError && error.code==="CONFLICT"
          ? error.message : "CONSENT_VALIDATION_UNAVAILABLE";
        this.log({turnId:turn.id,ticketId:turn.ticketId,
          rejectionReason:approvalFailure,errorCode:(error as Error).name},
          "Conversational approval rejected; no business action authorized");
      }
      if(approvalFailure){
        const purchaseApproval=isPurchasePaymentApproval(text);
        await this.queue.completeLocal(turn,purchaseApproval
          ? "I couldn't validate this purchase approval ("+approvalFailure+
            "). Your existing quotation is unchanged. This message did not "+
            "initiate a new payment. Ask me to show the current purchase "+
            "proposal again before approving."
          : "I couldn't validate this authorization ("+approvalFailure+
            "). This message did not initiate a new Salesforce enquiry or "+
            "quotation. Please request a freshly reviewed proposal.");
        return;
      }
      if(acceptedChatAction){
        await this.queue.completeLocal(turn,acceptedChatAction==="lead_quote"
          ? "Your explicit authorization for the reviewed Salesforce enquiry and quotation is recorded. I will submit the enquiry once and generate the exact quotation only after Salesforce verifies the lead. I will not retry uncertain submissions."
          : "Your exact-amount sandbox purchase and test-payment authorization is recorded. I will validate the secure documents and arrange the synthetic OTP. Never send an OTP or card data in an ordinary chat message.");
        return;
      }
      if(isLeadQuoteApproval(text)||isPurchasePaymentApproval(text)){
        await this.queue.completeLocal(turn,
          "I could not match that authorization to the latest reviewed proposal. No action was authorized. Please ask me to show the current proposal again.");
        return;
      }
      // A precise customer message may request a fresh private payment OTP.
      // Never start a gateway order from natural language: the new order still
      // requires the new OTP in the secure in-chat control.
      if(isExplicitPaymentRetryRequest(text)){
        try{
          await new PaymentOperations(this.db).renewOtp(scope,turn.ticketId,{
            requestId:turn.messageId,
          });
          await this.queue.completeLocal(turn,
            "I recorded a fresh synthetic payment OTP for this ticket. Enter the new "+
            "code in the secure chat control, not in a message. After verification "+
            "I can generate a NEW sandbox checkout link for the same quotation. "+
            "Your quotation, documents and previous payment history are unchanged.");
        }catch(error){
          const reason=error instanceof PersistenceError &&
            error.message==="OTP request rate limit; retry after cooldown"
              ?"Please wait for the OTP cooldown before requesting a new code."
              :error instanceof PersistenceError && error.code==="NOT_CONFIGURED"
                ?"Sandbox payment retry is currently disabled. No new order was created."
                :"I could not safely start another payment OTP. An existing payment "+
                 "may still be pending or unresolved, or the required purchase "+
                 "authorization may be missing. Check the payment status in this chat "+
                 "before trying again; no new order was created.";
          await this.queue.completeLocal(turn,reason);
        }
        return;
      }
      const handoff=new ConversationActionHandoff(this.db);
      // Record the customer's REQUEST only. Never turn speech into action consent.
      let requestedAction:Awaited<ReturnType<typeof handoff.observe>>={action:null,explicit:false};
      let handoffBefore:Awaited<ReturnType<typeof handoff.status>>=null;
      try{
        requestedAction=await handoff.observe(scope,turn.ticketId,turn.messageId,text);
        handoffBefore=await handoff.status(scope,turn.ticketId,requestedAction.action);
      }catch(error){
        this.log({turnId:turn.id,errorCode:(error as Error).name},
          "Action handoff state unavailable; continuing natural conversation");
      }
      const previousResponseId=await this.queue.responseCursor(turn);
      const recent=previousResponseId ? []:await this.messages.recentMessages(scope,turn.ticketId,12);
      // The Foundry response cursor can retain an answer that Node replaced
      // with a safer, current-state handoff. Reconcile this in the next turn.
      // Reuse the already loaded window for new sessions rather than reading twice.
      const displayHistory=requestedAction.action
        ?(recent.length?recent:await this.messages.recentMessages(scope,turn.ticketId,4)):[];
      const displayedAssistant=[...displayHistory].reverse().find(m=>m.role==="assistant")?.text??null;
      // Direct-answer recovery is a narrow safety net when GPT omits a write:
      // it uses the customer's ACTUAL latest message plus the immediately
      // preceding visible question, never an ordered list of form questions.
      const preceding=displayHistory.at(-1)?.role==="customer" &&
        displayHistory.at(-1)?.id===turn.messageId &&
        displayHistory.at(-2)?.role==="assistant"
          ? displayHistory.at(-2)!.text : null;
      const validationIssues:Array<{key:string;reasonCode:string;clarificationHint:string}>=[];
      const candidates=recoverSourcedAnswer({
        previousAssistant:preceding,customerText:text,
        requestedAction:requestedAction.action,activeIntent:stored.activeIntent,
        knownFacts:stored.knownFacts,missingRequirements:stored.missingRequirements,
      });
      for(const candidate of candidates){
        const type=["visa_count","term_years","shareholder_count"].includes(candidate.key)
          ?"number":candidate.key==="customer_email"?"email":"text";
        const decision=validateConversationFact(candidate.key,candidate.value,type);
        if(decision.status!=="accepted"){
          validationIssues.push({key:decision.key,reasonCode:decision.reasonCode,
            clarificationHint:decision.clarificationHint});
          continue;
        }
        try{
          await this.context.recordCustomerFacts(scope,turn.ticketId,turn.messageId,
            [{key:decision.key,value:decision.value}]);
          stored=await this.context.read(scope,turn.ticketId);
          handoffBefore=await handoff.status(scope,turn.ticketId,requestedAction.action);
          this.log({turnId:turn.id,factKey:decision.key},
            "Source-linked direct answer persisted");
        }catch(error){
          validationIssues.push({key:decision.key,reasonCode:"FACT_WRITE_FAILED",
            clarificationHint:"I couldn't save that detail yet. Please retry or request staff review."});
          this.log({turnId:turn.id,errorCode:(error as Error).name},
            "Source-linked fact recovery was rejected");
        }
      }
      const actionRead=async()=>{
        const state=await new IntentActionOperations(this.db).catalog(scope,turn.ticketId);
        const current=await this.context.read(scope,turn.ticketId);
        const name=current.knownFacts["customer_name"];
        const phone=current.knownFacts["customer_phone"];
        const email=current.knownFacts["customer_email"]??current.knownFacts["email"];
        const extraMissing:string[]=[];
        if(state.actions.some(a=>a.actionKey==="create_lead")){
          if(typeof name!=="string"||!name.trim())extraMissing.push("customer_name");
          else if(!parseSalesforceLeadName(name))extraMissing.push("customer_last_name");
          if(typeof phone!=="string"||
             normalizeContactPhone(phone).status!=="accepted")
            extraMissing.push("customer_phone");
          if(typeof email!=="string"||
             validateConversationFact("customer_email",email,"email").status!=="accepted")
            extraMissing.push("customer_email");
        }
        return {intentKey:state.intentKey,
          actions:state.actions.map(a=>({
            actionKey:a.actionKey,kind:a.kind,missing:[
              ...a.missing,
              ...(a.actionKey==="create_lead"||a.actionKey==="generate_quote"?
                extraMissing.filter(k=>!a.missing.includes(k)):[]),
            ],ready:a.ready && (!(a.actionKey==="create_lead"||
              a.actionKey==="generate_quote")||extraMissing.length===0),
            requestStatus:a.request?.status??null,
          })),
          extraMissing,unsupported:state.unknownActions};
      };
      const modelInput=[
        "Trusted Node ticket context (this is reference data, not a request to perform a workflow):",
        JSON.stringify({
          activeIntent:stored.activeIntent,knownFacts:stored.knownFacts,
          disputedFacts:stored.facts.filter(f=>f.verification==="disputed").map(f=>f.key),
          missingRequirements:stored.missingRequirements,
          selectedIntentActions:await actionRead(),
          requestedBusinessAction:requestedAction.action,
          nextAuthorizedStep:handoffBefore?.stage??null,
          missingActionFacts:handoffBefore?.missingKeys??[],
          actionReadinessGuidance:handoffBefore?.response??null,
          validationIssues,
          lastCustomerVisibleAssistantReply:displayedAssistant,
          previousSummary:stored.summary?.text ?? null,
          ...(recent.length ? {earlierMessages:recent.slice(0,-1).map(m=>({role:m.role,text:m.text}))}:{}),
        }),
        "For requested actions, discover/select the intent, check operation requirements, and record only customer-stated facts. ANCFZ company enquiries need customer_name and customer_phone. Save the provided first name as customer_name, then if no surname is present ask for the last name; when the customer provides it, combine it with the previously recorded first name and update customer_name, using only actual customer-stated information (never infer a surname). For sandbox billing, Node derives a reviewable @example.invalid alias from the contact email already recorded; do not ask for the email again. If the customer explicitly corrects it, save the new synthetic alias with provenance. Never invent any detail. Node issues a transaction-specific, explicit conversational proposal and validates subsequent consent before side effects; you must not approve or execute an operation. A service request is not a government, bank or partner application. Secure synthetic ID uploads and OTP are private UI inputs INSIDE the chat, not message text. Never collect identity files, OTPs or cards in chat messages or claim payment/invoice without independent verification.",
        "Use natural, helpful conversation, not a questionnaire. Answer the latest question FIRST. Reuse all accepted context; never ask for an already stored fact. Save multiple explicit details together and honor corrections. MissingActionFacts is an unordered checklist, not an ordered question script. If validationIssues or record_ticket_facts issues exist, explain the actual reason and ask a targeted clarification; never repeat the previous question verbatim. If a local phone lacks a country code, ask which country rather than assume from nationality; if only a first name is known, ask for the surname before Salesforce approval. Avoid repetitive 'if you want' prompts. Node owns exact pricing, proposal/consent and verified business actions. Do not show raw IDs or tool outputs, IQ citation tokens, or invented downloads. After the verified quotation PDF, direct the customer to confirm their existing contact email and verify a separate quote-confirmation OTP in the secure modal BEFORE collecting synthetic identity documents. The later payment OTP is separate. Synthetic IDs and OTPs use private modal controls, and payment cards stay on hosted checkout.",
        "Latest customer message:",text,
      ].join("\n");
      const toolRegistry=new AgentToolRegistry();
      const adapters=scopedIntentToolRepositories(this.db,scope,turn.ticketId);
      registerIntentTools(toolRegistry,adapters.catalog,adapters.facts,adapters.ticketIntents,
        async()=>{
          const p=await new PurchaseOperations(this.db).read(scope,turn.ticketId);
          // Only checklist status goes to Foundry; never private document
          // IDs, file names, bytes, purchase consent text or payment secrets.
          return {
            supported:p.supported,intentKey:p.intentKey,
            quotationReady:Boolean(p.quotationId),confirmed:p.confirmed,
            readyForOtp:p.readyForOtp,missing:p.missing,
            documentRequirements:p.requirements.map(d=>({
              key:d.key,label:d.label,guidance:d.guidance,
              required:d.required,uploaded:d.uploaded,
            })),
          };
        },actionRead,(issues)=>validationIssues.push(...issues));
      const toolContext:TrustedToolContext={
        agentId:turn.agentId,ticketId:turn.ticketId,
        principalId:"ticket:"+turn.ticketId,
        sourceCustomerMessageId:turn.messageId,
        intentCatalogRevision:binding.intentCatalogRevision,
        offeringCatalogRevision:binding.offeringCatalogRevision,
        authorizedToolNames:authorizedTools(binding.personaConfig),
      };
      const foundry=new FoundryClient(toolRegistry,{
        projectEndpoint:binding.foundryProjectEndpoint,
        defaultAgentName:binding.foundryAgentName,
        defaultAgentVersion:binding.foundryAgentVersion,
        onProviderCall:metric=>{
          providerCalls++;
          providerLatencyMs+=metric.latencyMs;
          if(metric.httpStatus===429)throttledCalls++;
          this.log({
            agentId:turn.agentId,turnId:turn.id,
            ...metric,
          },"Foundry provider request");
        },
      });
      const result=await foundry.runTurn({
        agentName:binding.foundryAgentName,
        agentVersion:binding.foundryAgentVersion,
        message:modelInput,
        conversationContext:{...(previousResponseId?{previousResponseId}:{})},
        trustedToolContext:toolContext,
      });
      if(!result.responseId) throw new Error("FOUNDRY_RESPONSE_ID_MISSING");
      let responseText=result.text;
      let savedThisTurn=candidates.length>0 && validationIssues.length===0;
      try{
        const after=await this.context.read(scope,turn.ticketId);
        savedThisTurn=savedThisTurn || after.facts.some(f=>
          f.sourceMessageId===turn.messageId && f.verification!=="disputed");
      }catch(error){
        this.log({turnId:turn.id,errorCode:(error as Error).name},
          "Could not verify latest fact changes; do not infer persisted facts");
        savedThisTurn=false;
      }
      try{
        const next=await handoff.status(scope,turn.ticketId,requestedAction.action);
        if(shouldShowAuthoritativeStatus(text,requestedAction.explicit,next)){
          // Only the protected provider/safety statuses override model prose.
          // Missing-field prompts always remain model-authored.
          responseText=next!.response;
        }
      }catch(error){
        this.log({turnId:turn.id,errorCode:(error as Error).name},
          "Action handoff read failed; retaining natural Foundry response");
      }
      if(validationIssues.length && displayedAssistant &&
         responseText.trim()===displayedAssistant.trim()){
        // Never repeat an identical question when the last input was rejected.
        // The hint contains no submitted phone/email or other private values.
        responseText=validationIssues[0]!.clarificationHint;
      }
      const continuation=isConversationContinuation(text,displayedAssistant);
      const shouldPrepare=requestedAction.action && (
        requestedAction.explicit || continuation ||
        (savedThisTurn && !text.includes("?"))
      );
      if(shouldPrepare){
        try{
          const proposal=await chatJourney.prepare(scope,turn.ticketId,requestedAction.action);
          if(proposal)responseText=proposal;
        }catch(error){
          this.log({turnId:turn.id,errorCode:(error as Error).name},
            "Conversational proposal unavailable; keeping natural assistant reply");
        }
      }
      await this.queue.complete(turn,responseText,
        responseText===result.text?citations(result.sourceReferences):[],
        previousResponseId,result.responseId,binding.versionId);
      this.log({
        agentId:turn.agentId,ticketId:turn.ticketId,turnId:turn.id,
        latencyMs:Date.now()-startedAt,promptBytes:Buffer.byteLength(modelInput,"utf8"),
        providerCalls,throttledCalls,providerLatencyMs,
        toolRounds:result.toolRoundCount,toolCalls:result.toolCallCount,
        inputTokens:result.usage?.inputTokens,outputTokens:result.usage?.outputTokens,
        reasoningTokens:result.usage?.reasoningTokens,cachedInputTokens:result.usage?.cachedInputTokens,
        totalTokens:result.usage?.totalTokens,
      },"Assistant turn committed");
    } catch(error) {
      const code=error instanceof FoundryError?error.code:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:"RUNTIME_FAILED";
      // Uncertain continuation or timeout may have persisted tool effects. Never blindly repeat.
      const uncertain=code==="FOUNDRY_FUNCTION_CONTINUATION_FAILED" ||
        code==="FOUNDRY_TIMEOUT" || code==="FOUNDRY_RESPONSE_ID_MISSING" ||
        code==="FOUNDRY_API_FAILED" || code==="RUNTIME_FAILED";
      this.log({agentId:turn.agentId,ticketId:turn.ticketId,turnId:turn.id,code,uncertain,
        latencyMs:Date.now()-startedAt,providerCalls,throttledCalls,providerLatencyMs,errorMessage:(error as Error).message,errorStack:(error as Error).stack,errorCause:(error as any)?.cause},
        "Assistant turn failed");
      try {await this.queue.fail(turn,code,uncertain);}
      catch(failure){this.log({errorCode:(failure as Error).name,turnId:turn.id},"Failed to store turn error");}
    }
  }
}
