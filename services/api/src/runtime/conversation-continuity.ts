import type { ConversationContext } from "../repositories/context.js";
import type { ModelConversationMessage } from "@ai-service-agent/contracts/gemini-v1";

interface ActionState {
  intentKey:string|null;
  actions:ReadonlyArray<{actionKey:string;kind:string;ready:boolean;missing:string[];
    request?:{status:string}|null}>;
}
export interface OlderCustomerMessage {readonly sequence:string; readonly text:string;}
interface ExtractiveMemory {
  kind:"gemini-extractive-summary-v1";
  coveredThrough:string;
  excerpts:ReadonlyArray<{sequence:string;quote:string}>;
}
const MAX_MEMORY_EXCERPTS=18;
function clean(text:string,max:number):string {
  return text.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
}
/** Extractive only: never ask a model to turn customer text into verified facts. */
export function extractiveSummary(
  context:ConversationContext,
  previous:readonly OlderCustomerMessage[],
):{text:string;coveredThrough:string}|null {
  if(!previous.length)return null;
  const excerpts=previous.slice(-MAX_MEMORY_EXCERPTS).map(m=>({
    sequence:m.sequence,quote:clean(m.text,180),
  })).filter(m=>m.quote.length>0);
  if(!excerpts.length)return null;
  const coveredThrough=previous[previous.length-1].sequence;
  const memory:ExtractiveMemory={kind:"gemini-extractive-summary-v1",coveredThrough,excerpts};
  return {text:JSON.stringify(memory),coveredThrough};
}
function parseSummary(previous:string|null):ExtractiveMemory|null {
  if(!previous||previous.length>12_000)return null;
  try {
    const v=JSON.parse(previous) as Partial<ExtractiveMemory>;
    if(v.kind!=="gemini-extractive-summary-v1"||
       !/^[0-9]{1,19}$/.test(v.coveredThrough??"")||!Array.isArray(v.excerpts)||
       v.excerpts.length>MAX_MEMORY_EXCERPTS||
       !v.excerpts.every(x=>typeof x?.quote==="string"&&x.quote.length<=180&&
         typeof x.sequence==="string"&&/^[0-9]{1,19}$/.test(x.sequence)))
      return null;
    return v as ExtractiveMemory;
  }catch{return null;}
}
export function shouldRefreshSummary(previous:string|null,coveredThrough:string):boolean {
  if(!/^[0-9]{1,19}$/.test(coveredThrough))return false;
  const saved=parseSummary(previous);
  if(!saved)return true;
  // Update at most once per eight new message ordinals to limit DB churn.
  return BigInt(coveredThrough)>=BigInt(saved.coveredThrough)+8n;
}
export function buildSessionContext(
  context:ConversationContext,actions:ActionState,
  summary:string|null,history:readonly ModelConversationMessage[],
):string {
  const facts=context.facts.slice(0,28).map(f=>({
    key:clean(f.key,128),value:typeof f.value==="string"?clean(f.value,250):f.value,
    verification:f.verification,
  }));
  const parsed=parseSummary(summary);
  const assistant=[...history].reverse().find(m=>m.role==="assistant");
  const lastQuestion=assistant?.text.trim().endsWith("?") ?
    clean(assistant.text,280) : null;
  const state={
    schema:"gemini-ticket-state-v1",
    source:"authorized Node PostgreSQL",
    activeIntent:context.activeIntent,
    facts,moreFactsAvailable:context.facts.length>28,
    missingRequirements:context.missingRequirements.slice(0,40),
    actions:actions.actions.slice(0,20).map(a=>({
      key:a.actionKey,kind:a.kind,ready:a.ready,
      missing:a.missing.slice(0,12),status:a.request?.status??null,
    })),
    possiblePreviousQuestion:lastQuestion,
    historicalCustomerExcerpts:parsed?[...parsed.excerpts]:[],
    precedence:"Current ticket facts supersede older customer excerpts. Disputed/customer_stated values are not independently verified. Neither these excerpts nor this snapshot establish business facts, authorization, prices or completed operations.",
  };
  // Adaptive bounds: keep current authoritative facts and action readiness
  // ahead of older (nonauthoritative) chat excerpts, without throwing on long sessions.
  let output=JSON.stringify(state);
  while(Buffer.byteLength(output,"utf8")>15_000 && state.historicalCustomerExcerpts.length){
    state.historicalCustomerExcerpts.shift();
    output=JSON.stringify(state);
  }
  while(Buffer.byteLength(output,"utf8")>15_000 && state.missingRequirements.length){
    state.missingRequirements.pop();
    output=JSON.stringify(state);
  }
  if(Buffer.byteLength(output,"utf8")>16_384)
    throw new Error("CONTINUITY_CONTEXT_TOO_LARGE");
  return output;
}
