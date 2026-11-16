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
import {LicenceRenewalOperations} from "./licence-renewal.js";
import { IntentActionOperations } from "./intent-action-operations.js";
import { ConversationActionHandoff, shouldUseHandoff } from "./conversation-action-handoff.js";
import { ChatJourney, isLeadQuoteApproval, isPurchasePaymentApproval } from "./chat-journey.js";

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
      const stored=await this.context.read(scope,turn.ticketId);
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
        await this.queue.completeLocal(turn,
          "I couldn't validate that authorization ("+approvalFailure+
          "). No Salesforce enquiry or payment was initiated. "+
          "Please request a freshly reviewed proposal before approving again.");
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
      const actionRead=async()=>{
        const state=await new IntentActionOperations(this.db).catalog(scope,turn.ticketId);
        return {intentKey:state.intentKey,
          actions:state.actions.map(a=>({
            actionKey:a.actionKey,kind:a.kind,missing:a.missing,ready:a.ready,
            requestStatus:a.request?.status??null,
          })),
          unsupported:state.unknownActions};
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
          nextQuestionOrStep:handoffBefore?.response??null,
          lastCustomerVisibleAssistantReply:displayedAssistant,
          previousSummary:stored.summary?.text ?? null,
          ...(recent.length ? {earlierMessages:recent.slice(0,-1).map(m=>({role:m.role,text:m.text}))}:{}),
        }),
        "For requested actions, discover/select the intent, check operation requirements, and record only customer-stated facts. ANCFZ company enquiries also need customer_name and customer_phone (record from the customer's own message); sandbox payments use a synthetic customer_test_email ending @example.invalid. Never invent any detail. Node issues a transaction-specific, explicit conversational proposal and validates subsequent consent before side effects; you must not approve or execute an operation. A service request is not a government, bank or partner application. Licence renewal requires selecting the licence_renewal intent and the customer's ANCFZ-TEST licence lookup and confirmation in the secure in-chat renewal panel. Do not infer licence details, invent renewal prices, or claim a licence is renewed because payment passed; fulfilment awaits staff verification. Secure synthetic ID uploads and OTP are private UI inputs INSIDE the chat, not message text. Never collect identity files, OTPs or cards in chat messages or claim payment/invoice without independent verification.",
        "Honor lastCustomerVisibleAssistantReply over older model text. Reply naturally in 1–3 sentences unless detail is requested. For formal quotes/PDFs, record sourced contact and package facts; ask ONE missing fact at a time and never invent facts. Node provides the exact price, proposal and consent text in the conversation. No separate Available Actions panel exists. Guide private document and OTP inputs in the chat UI; payment-card entry is on the hosted test checkout. Do not display IQ citations or invented download URLs.",
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
        },actionRead);
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
      // If the customer already supplied the synthetic licence number in
      // ordinary chat, reuse it for ONE scoped read-only lookup after Foundry
      // has selected the renewal intent. No second copy/paste is required.
      const licenceMatch=text.toUpperCase().match(/\\bANCFZ-TEST-[A-Z0-9-]{4,40}\\b/);
      if(licenceMatch){
        try{
          const renewals=new LicenceRenewalOperations(this.db);
          const status=await renewals.read(scope,turn.ticketId);
          if(status.applicable && status.enabled && !status.record){
            await renewals.lookup(scope,turn.ticketId,{
              licenceNumber:licenceMatch[0],
            });
            responseText="A matching synthetic licence record was found. "+
              "Review the details in the secure renewal panel and confirm "+
              "them before I can prepare your renewal quotation.";
          }
        }catch(error){
          responseText=error instanceof PersistenceError?
            error.message:"The private renewal lookup is unavailable. Please "+
              "retry from the secure renewal panel or request staff review.";
          this.log({turnId:turn.id,errorCode:(error as Error).name},
            "Automatic synthetic licence lookup did not confirm a record");
        }
      }
      try{
        const next=await handoff.status(scope,turn.ticketId,requestedAction.action);
        if(shouldUseHandoff(text,requestedAction.explicit,handoffBefore,next)&&next){
          // This user-visible handoff is grounded in CURRENT persisted facts and
          // verified provider state, AFTER any model-executed fact writes.
          responseText=next.response;
        }
      }catch(error){
        this.log({turnId:turn.id,errorCode:(error as Error).name},
          "Action handoff read failed; retaining the normal Foundry response");
      }
      try {
        const proposal=await chatJourney.prepare(scope,turn.ticketId,requestedAction.action);
        if(proposal)responseText=proposal;
      }catch(error){
        this.log({turnId:turn.id,errorCode:(error as Error).name},
          "Conversational proposal unavailable; keeping normal assistant reply");
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
