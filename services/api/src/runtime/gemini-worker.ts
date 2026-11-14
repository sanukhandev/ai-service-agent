import type {
  AgentRuntimeBinding,AiSessionState, GroundingDecision, ModelTurnCandidate,
  ModelTurnRequest,NodeBusinessToolName,
} from "@ai-service-agent/contracts/gemini-v1";
import { createOfficialGeminiAdapter, type GeminiAdapterOptions, type GeminiModelAdapter } from "../gemini/adapter.js";
import { verifyGrounding } from "../grounding/index.js";
import { AgentToolRegistry, type RegisteredToolName, type TrustedToolContext } from "../agent/tool-registry.js";
import { registerIntentTools } from "../agent/intent-tools.js";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { scopedIntentToolRepositories } from "../repositories/intent-adapter.js";
import { GeminiBindingRepository,GeminiSessionRepository } from "../repositories/gemini.js";
import { PgGeminiPendingStore } from "../repositories/gemini-pending.js";
import { ConversationContextRepository } from "../repositories/context.js";
import { workerTicketScope } from "../repositories/types.js";
import { resolveGeminiEvidence } from "./gemini-evidence.js";
import { TurnQueue,type PendingTurn } from "./turn-queue.js";

const TOOL_NAMES: ReadonlySet<string> = new Set([
  "find_intents","select_ticket_intent","get_intent_requirements",
  "record_ticket_facts","get_offerings",
]);
const FALLBACK="I don't have confirmed information in the approved documents for that question. Could you clarify what you need?";
function fallbackDecision(): GroundingDecision {
  return {status:"supported",category:"clarification",
    verifierVersion:"node-gemini-safe-abstention-v1",claims:[],reasonCode:null};
}
function failureCode(code:string):string {
  return /^[A-Z_]{3,64}$/.test(code)?code:"GEMINI_RUNTIME_FAILED";
}

/** One provider path; the old Foundry worker is not started on this branch. */
export class GeminiTurnWorker {
  private busy=false;
  private stopped=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  private lastRecovery=0;
  private readonly sessions:GeminiSessionRepository;
  private readonly bindings:GeminiBindingRepository;
  private readonly context:ConversationContextRepository;

  constructor(private readonly db:PersistenceDatabase,private readonly queue:TurnQueue,
    private readonly log:(data:Record<string,unknown>,message:string)=>void,
    private readonly apiKey:string,private readonly encryptionKey:string,
    private readonly adapterFactory:(apiKey:string,options:GeminiAdapterOptions)=>
      Promise<Pick<GeminiModelAdapter,"runTurn"|"continueWithFunctionOutputs">>
      =createOfficialGeminiAdapter) {
    this.sessions=new GeminiSessionRepository(db);
    this.bindings=new GeminiBindingRepository(db);
    this.context=new ConversationContextRepository(db);
    if(!apiKey.trim())throw new PersistenceError("NOT_CONFIGURED","GEMINI_API_KEY is required");
    if(!/^[a-f\d]{64}$/i.test(encryptionKey))
      throw new PersistenceError("NOT_CONFIGURED","GEMINI_STATE_ENCRYPTION_KEY must be a 32-byte hex secret");
  }

  async start():Promise<void> {
    await this.queue.reconcileMissing();
    await this.queue.recoverAbandoned();
    this.timer=setInterval(()=>{void this.tick();},1250);
    this.timer.unref();
    void this.tick();
  }
  stop():void {this.stopped=true;if(this.timer)clearInterval(this.timer);}

  private async tick():Promise<void> {
    if(this.busy||this.stopped)return;
    this.busy=true;
    try {
      if(Date.now()-this.lastRecovery>30000){
        await this.queue.reconcileMissing();
        await this.queue.recoverAbandoned();
        this.lastRecovery=Date.now();
      }
      const turn=await this.queue.claim();
      if(turn)await this.process(turn);
    }catch(e){
      this.log({code:(e as Error).name},"Gemini worker poll failed");
    }finally{this.busy=false;}
  }

  private async verify(scope:ReturnType<typeof workerTicketScope>,
    session:AiSessionState,agent:AgentRuntimeBinding,candidate:ModelTurnCandidate) {
    const proof=await resolveGeminiEvidence(this.db,scope,session,agent,candidate);
    return verifyGrounding({candidate:proof.candidate,agent,session,
      documents:proof.documents,catalogs:proof.catalogs,operations:proof.operations});
  }

  private async process(turn:PendingTurn):Promise<void> {
    let toolsExecuted=false;
    try {
      const scope=workerTicketScope(turn.agentId,turn.ticketId);
      const active=await this.sessions.forTicket(scope,turn.ticketId);
      if(!active?.active)throw new PersistenceError("CONFLICT","SESSION_EXPIRED");
      const session=active.session;
      const agent=await this.bindings.forSession(scope,session.sessionId);
      const current=active.messages.find(x=>x.id===turn.messageId);
      if(!current || current.role!=="customer")throw new Error("CUSTOMER_MESSAGE_NOT_FOUND");
      const context=await this.context.read(scope,turn.ticketId);
      if(!context.intentCatalogRevision || !context.offeringCatalogRevision)
        throw new Error("PINNED_CATALOG_MISSING");
      const registry=new AgentToolRegistry();
      const repositories=scopedIntentToolRepositories(this.db,scope,turn.ticketId);
      registerIntentTools(registry,repositories.catalog,repositories.facts,repositories.ticketIntents);
      const allowed=new Set<RegisteredToolName>(agent.authorizedToolNames.filter(
        (name): name is RegisteredToolName=>TOOL_NAMES.has(name)));
      const toolContext:TrustedToolContext={
        agentId:turn.agentId,ticketId:turn.ticketId,principalId:"ticket:"+turn.ticketId,
        sourceCustomerMessageId:turn.messageId,
        intentCatalogRevision:context.intentCatalogRevision,
        offeringCatalogRevision:context.offeringCatalogRevision,
        authorizedToolNames:allowed,
      };
      const definitions=registry.definitions(toolContext).map(({name,description,parameters})=>({
        name,description,parameters,
      }));
      const requestedTools=definitions.map(d=>d.name as NodeBusinessToolName);
      const pendingStore=new PgGeminiPendingStore(this.db,turn.agentId,session.sessionId,this.encryptionKey);
      const adapter=await this.adapterFactory(this.apiKey,{
        declarations:()=>definitions,pendingStore,combinedToolsLiveVerified:false,
        maxRounds:4,maxCalls:8,
      });
      const history=active.messages.filter(m=>m.id!==turn.messageId)
        .slice(-16).map(m=>({role:m.role as "customer"|"assistant",
          text:m.text,sourceMessageId:m.id}));
      const request:ModelTurnRequest={
        requestId:turn.requestId,acceptedCustomerMessageId:turn.messageId,
        agent,session,currentSessionHistory:history,
        customerMessage:current.text,
        allowedBuiltinTools:agent.knowledge?["file_search"]:[],
        allowedBusinessToolNames:requestedTools,deadlineMs:45000,
      };
      // Node orchestrates read-only business tools and File Search separately.
      // This avoids relying on a Preview combined-tool API capability.
      let response=await adapter.runTurn(request,{phase:"functions"});
      if(response.kind==="failure")throw new Error(failureCode(response.code));
      let candidate=response.candidate;
      let rounds=0;
      while(candidate.functionCalls.length){
        if(++rounds>4)throw new Error("GEMINI_TOOL_ROUNDS_EXCEEDED");
        const continuation=candidate.continuation?.pendingToolStateRef;
        if(!continuation)throw new Error("GEMINI_PENDING_STATE_MISSING");
        const outputs=[];
        for(const call of candidate.functionCalls){
          // Business execution is deliberately impossible from this registry:
          // it exposes only Node-owned intent and customer-fact methods.
          const result=await registry.execute(call,toolContext);
          toolsExecuted=true;
          outputs.push({callId:call.callId,outputJson:JSON.stringify(result)});
        }
        response=await adapter.continueWithFunctionOutputs(request,continuation,outputs,{phase:"functions"});
        if(response.kind==="failure")throw new Error(failureCode(response.code));
        candidate=response.candidate;
      }
      let decision=await this.verify(scope,session,agent,candidate);
      if(decision.status!=="supported" && agent.knowledge){
        // Knowledge-only second pass; no web, URL tool or business function.
        const grounded=await adapter.runTurn({...request,allowedBusinessToolNames:[]},
          {phase:"knowledge"});
        if(grounded.kind==="candidate" && !grounded.candidate.functionCalls.length){
          const second=await this.verify(scope,session,agent,grounded.candidate);
          if(second.status==="supported"){
            candidate=grounded.candidate;
            decision=second;
          }
        }
      }
      const approved=decision.status==="supported";
      await this.queue.completeGemini(turn,session.sessionId,
        approved?candidate.text:FALLBACK,[],approved?decision:fallbackDecision());
      this.log({agentId:turn.agentId,turnId:turn.id,
        grounding:decision.status,category:decision.category},
        "Gemini turn completed with independent response qualification");
    }catch(error){
      const code=failureCode(error instanceof Error?error.message:"GEMINI_RUNTIME_FAILED");
      this.log({agentId:turn.agentId,turnId:turn.id,code},"Gemini turn failed");
      try{await this.queue.fail(turn,code,toolsExecuted);}
      catch(e){this.log({turnId:turn.id,code:(e as Error).name},"Gemini queue failure persistence failed");}
    }
  }
}
