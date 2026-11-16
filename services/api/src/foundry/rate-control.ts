/** Single-request 429 recovery. Never rerun a turn or its already-executed tools. */
import { FoundryError } from "./errors.js";

const RATE_KEYS = [
  "retry-after", "retry-after-ms",
  "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens",
] as const;

function header(source: unknown, name: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const object = source as { get?: (key: string) => string | null };
  if (typeof object.get === "function") return object.get(name) ?? undefined;
  const entry = Object.entries(source).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** Explicit allowlist: never log arbitrary response headers or credentials. */
export function rateLimitHeaders(source: unknown): Record<string,string> {
  const result: Record<string,string> = {};
  for (const key of RATE_KEYS) {
    const value = header(source,key);
    if (value && value.length <= 80) result[key] = value;
  }
  return result;
}

export function retryAfterMs(headers: Record<string,string>, now = Date.now()): number | null {
  const ms = headers["retry-after-ms"];
  if (ms && /^\d+(?:\.\d+)?$/.test(ms)) {
    const value = Number(ms);
    return Number.isFinite(value) ? Math.ceil(value) : null;
  }
  const seconds = headers["retry-after"];
  if (!seconds) return null;
  if (/^\d+(?:\.\d+)?$/.test(seconds)) {
    const value = Number(seconds) * 1000;
    return Number.isFinite(value) ? Math.ceil(value) : null;
  }
  const date = Date.parse(seconds);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function resetMs(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i.exec(value);
  if (!match) return null;
  const scale: Record<string,number> = {ms:1,s:1000,m:60000,h:3600000};
  const result = Number(match[1]) * scale[match[2].toLowerCase()];
  return Number.isFinite(result) ? Math.ceil(result) : null;
}

type PacingState = { nextRequestAt:number; cooldownUntil:number };
const states = new Map<string,PacingState>();
function state(key:string):PacingState {
  let entry=states.get(key);
  if(!entry){ entry={nextRequestAt:0,cooldownUntil:0};states.set(key,entry); }
  return entry;
}
function observeHeadroom(current:PacingState, headers:Record<string,string>):void {
  for(const kind of ["requests","tokens"]){
    if(headers["x-ratelimit-remaining-"+kind] !== "0") continue;
    const reset=resetMs(headers["x-ratelimit-reset-"+kind]);
    if(reset!==null)current.cooldownUntil=Math.max(current.cooldownUntil,Date.now()+reset);
  }
}
function sleep(ms:number,signal:AbortSignal):Promise<void> {
  if(signal.aborted) return Promise.reject(new Error("Foundry request aborted"));
  if(ms<=0)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(new Error("Foundry request aborted"));};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
    signal.addEventListener("abort",abort,{once:true});
  });
}

export interface FoundryCallObservation {
  phase:"initial"|"continuation";
  attempt:number;
  httpStatus:number;
  latencyMs:number;
  requestId?:string;
  headers:Record<string,string>;
  nextDelayMs?:number;
}
export interface FoundryRateOptions {
  key:string;
  phase:"initial"|"continuation";
  signal:AbortSignal;
  deadlineAt:number;
  onObservation?:(metric:FoundryCallObservation)=>void;
}
/** Return only the parsed provider reply; trace HTTP metrics through callback. */
export async function with429Backoff<T>(
  send:()=>Promise<{data:T;response:Response;request_id?:string|null}>,
  options:FoundryRateOptions,
):Promise<T> {
  const current=state(options.key);
  const spacing=1500; // Conservative single-process burst smoothing for the POC.
  const maxAttempts=3;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const now=Date.now();
    const requestAt=Math.max(now,current.nextRequestAt,current.cooldownUntil);
    current.nextRequestAt=requestAt+spacing;
    if(requestAt>=options.deadlineAt)throw new FoundryError(
      "FOUNDRY_RATE_LIMIT","Foundry rate-limit pacing exceeded the request deadline",true,429);
    await sleep(requestAt-now,options.signal);
    // Another call might have received 429 while this one waited.
    if(current.cooldownUntil>Date.now()) {
      if(current.cooldownUntil>=options.deadlineAt)throw new FoundryError(
        "FOUNDRY_RATE_LIMIT","Foundry cooldown exceeded the request deadline",true,429);
      await sleep(current.cooldownUntil-Date.now(),options.signal);
    }
    const started=Date.now();
    try{
      const result=await send();
      const headers=rateLimitHeaders(result.response.headers);
      observeHeadroom(current,headers);
      options.onObservation?.({
        phase:options.phase,attempt,httpStatus:result.response.status,
        latencyMs:Date.now()-started,...(result.request_id?{requestId:result.request_id}:{}),headers,
      });
      return result.data;
    }catch(error){
      const info=error && typeof error==="object" ? error as {
        status?:number;statusCode?:number;headers?:unknown;request_id?:string
      }:{};
      const status=info.status??info.statusCode;
      // Retry only definitive HTTP 429 rejections, never ambiguous timeouts/5xx.
      if(status!==429)throw error;
      const headers=rateLimitHeaders(info.headers);
      const providerDelay=retryAfterMs(headers);
      const fallback=Math.min(8000,750*2**(attempt-1));
      const delay=providerDelay??fallback;
      const canRetry=attempt<maxAttempts && !options.signal.aborted &&
        Date.now()+delay<options.deadlineAt;
      if(canRetry)current.cooldownUntil=Math.max(current.cooldownUntil,Date.now()+delay);
      options.onObservation?.({
        phase:options.phase,attempt,httpStatus:429,latencyMs:Date.now()-started,
        ...(info.request_id?{requestId:info.request_id}:{}),headers,
        ...(canRetry?{nextDelayMs:delay}:{}),
      });
      if(!canRetry)throw error;
      // Next iteration waits on the shared cooldown; do not invoke model tools.
    }
  }
  throw new FoundryError("FOUNDRY_RATE_LIMIT","Foundry request retries exhausted",true,429);
}
