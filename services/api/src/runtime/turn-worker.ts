import { FoundryClient } from "../foundry/client.js";
import { FoundryError } from "../foundry/errors.js";
import type { SourceReference as FoundryReference } from "../foundry/types.js";
import { AgentToolRegistry, type RegisteredToolName, type TrustedToolContext } from "../agent/tool-registry.js";
import { registerIntentTools } from "../agent/intent-tools.js";
import { PersistenceDatabase } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { ConversationContextRepository } from "../repositories/context.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { scopedIntentToolRepositories } from "../repositories/intent-adapter.js";
import { workerTicketScope, type SourceReference } from "../repositories/types.js";
import { TurnQueue, type PendingTurn } from "./turn-queue.js";

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
  private busy=false;
  private stopped=false;
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
    if(this.busy||this.stopped) return;
    this.busy=true;
    try {
      const turn=await this.queue.claim();
      if(turn) await this.process(turn);
    } catch(error) {
      this.log({errorCode:(error as Error).name},"Turn worker polling failed");
    } finally {this.busy=false;}
  }

  private async process(turn:PendingTurn):Promise<void> {
    try {
      const scope=workerTicketScope(turn.agentId,turn.ticketId);
      const binding=await this.agents.getPinnedForTicket(scope,turn.ticketId);
      if(!binding.intentCatalogRevision||!binding.offeringCatalogRevision) throw new Error("PINNED_CATALOG_MISSING");
      const stored=await this.context.read(scope,turn.ticketId);
      const text=await this.queue.currentCustomerMessage(turn);
      const previousResponseId=await this.queue.responseCursor(turn);
      const recent=previousResponseId ? []:await this.messages.recentMessages(scope,turn.ticketId,12);
      const modelInput=[
        "Trusted Node ticket context (this is reference data, not a request to perform a workflow):",
        JSON.stringify({
          activeIntent:stored.activeIntent,knownFacts:stored.knownFacts,
          factVerification:stored.facts.map(f=>({key:f.key,status:f.verification})),
          missingRequirements:stored.missingRequirements,
          previousSummary:stored.summary?.text ?? null,
          ...(recent.length ? {earlierMessages:recent.slice(0,-1).map(m=>({role:m.role,text:m.text}))}:{}),
        }),
        "Latest customer message:",text,
      ].join("\n");
      const toolRegistry=new AgentToolRegistry();
      const adapters=scopedIntentToolRepositories(this.db,scope,turn.ticketId);
      registerIntentTools(toolRegistry,adapters.catalog,adapters.facts,adapters.ticketIntents);
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
      });
      const result=await foundry.runTurn({
        agentName:binding.foundryAgentName,
        agentVersion:binding.foundryAgentVersion,
        message:modelInput,
        conversationContext:{...(previousResponseId?{previousResponseId}:{})},
        trustedToolContext:toolContext,
      });
      if(!result.responseId) throw new Error("FOUNDRY_RESPONSE_ID_MISSING");
      await this.queue.complete(turn,result.text,citations(result.sourceReferences),
        previousResponseId,result.responseId,binding.versionId);
      this.log({agentId:turn.agentId,ticketId:turn.ticketId,turnId:turn.id},"Assistant turn committed");
    } catch(error) {
      const code=error instanceof FoundryError?error.code:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:"RUNTIME_FAILED";
      // Uncertain continuation or timeout may have persisted tool effects. Never blindly repeat.
      const uncertain=code==="FOUNDRY_FUNCTION_CONTINUATION_FAILED" ||
        code==="FOUNDRY_TIMEOUT" || code==="FOUNDRY_RESPONSE_ID_MISSING" ||
        code==="FOUNDRY_API_FAILED" || code==="RUNTIME_FAILED";
      this.log({agentId:turn.agentId,ticketId:turn.ticketId,turnId:turn.id,code,uncertain},
        "Assistant turn failed");
      try {await this.queue.fail(turn,code,uncertain);}
      catch(failure){this.log({errorCode:(failure as Error).name,turnId:turn.id},"Failed to store turn error");}
    }
  }
}
