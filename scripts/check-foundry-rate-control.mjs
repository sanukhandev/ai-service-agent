#!/usr/bin/env node
/** Offline deterministic 429 safety regression: no Azure, DB or n8n calls. */
import assert from "node:assert/strict";
import {with429Backoff,retryAfterMs,rateLimitHeaders} from "../services/api/dist/foundry/rate-control.js";

assert.equal(retryAfterMs({"retry-after-ms":"75"}),75);
assert.equal(retryAfterMs({"retry-after":"2"}),2000);
assert.equal(retryAfterMs({"retry-after":"bad"}),null);
assert.deepEqual(rateLimitHeaders({Authorization:"sensitive","Retry-After":"2","x-ratelimit-remaining-tokens":"0"}),
  {"retry-after":"2","x-ratelimit-remaining-tokens":"0"});
const signal=new AbortController().signal;
const deadline=()=>Date.now()+15000;
const observed=[];
let attempts=0;
const first=await with429Backoff(async()=>{
  attempts++;
  if(attempts===1){
    throw Object.assign(new Error("Rate limited"),{status:429,headers:{"retry-after-ms":"10"}});
  }
  return {data:{id:"resp_accepted"},response:new Response(null,{
    status:200,headers:{"x-ratelimit-remaining-requests":"99"},
  }),request_id:"req_ok"};
},{
  key:"offline-first",phase:"initial",signal,deadlineAt:deadline(),
  onObservation:m=>observed.push(m),
});
assert.deepEqual(first,{id:"resp_accepted"});
assert.equal(attempts,2);
assert.deepEqual(observed.map(x=>x.httpStatus),[429,200]);
assert.equal(observed[0].nextDelayMs,10);
assert.equal(observed[1].requestId,"req_ok");

// A tool has already executed; the exact same submitted function outputs are reused.
// No outer turn rerun or extra tool execution occurs.
let toolExecutions=0;
const output={type:"function_call_output",call_id:"call_same",output:"{}"};
function executeToolOnce(){toolExecutions++;return output;}
const persisted=executeToolOnce();
let continuationAttempts=0;
await with429Backoff(async()=>{
  continuationAttempts++;
  assert.equal(persisted,output);
  if(continuationAttempts===1)
    throw Object.assign(new Error("Rate limited"),{status:429,headers:{"retry-after-ms":"1"}});
  return {data:{id:"resp_continued"},response:new Response(null,{status:200})};
},{key:"offline-continuation",phase:"continuation",signal,deadlineAt:deadline()});
assert.equal(continuationAttempts,2);
assert.equal(toolExecutions,1,"429 recovery must never execute the tool twice");

for(const status of [400,401,500]){
  let calls=0;
  await assert.rejects(()=>with429Backoff(async()=>{
    calls++;throw Object.assign(new Error("not retryable"),{status});
  },{key:"offline-fail-"+status,phase:"initial",signal,deadlineAt:deadline()}));
  assert.equal(calls,1,"Non-429 errors must never retry");
}
let capped=0;
await assert.rejects(()=>with429Backoff(async()=>{
  capped++;throw Object.assign(new Error("429"),{status:429,headers:{"retry-after-ms":"90000"}});
},{key:"offline-long-delay",phase:"continuation",signal,deadlineAt:deadline()}));
assert.equal(capped,1,"Retry-After beyond turn budget must not cause another call");
console.log("Foundry rate control PASS: 429 header parsing, bounded retries, non-429 rejection, tool continuation without replay");
