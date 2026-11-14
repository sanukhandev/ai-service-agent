import test from "node:test";
import assert from "node:assert/strict";
import {
  GeminiModelAdapter, type GeminiGenerateClient, type PendingFunctionStore,
  type PendingFunctionState, type GeminiContent,
} from "./adapter.js";
import type { ModelTurnRequest } from "@ai-service-agent/contracts/gemini-v1";

const now = new Date();
const future = new Date(Date.now() + 3_600_000).toISOString();
function request(patch: Partial<ModelTurnRequest> = {}): ModelTurnRequest {
  const agent = {
    agentId: "agent-one", agentVersionId: "version-one", provider: "gemini" as const,
    modelId: "gemini-2.5-flash", personaVersion: "persona-v1",
    systemInstructions: "You are Sara, an ANCFZ assistant.",
    authorizedToolNames: ["find_intents", "get_offerings"] as const,
    knowledge: { agentId: "agent-one", knowledgeVersionId: "kb-v1", provider: "gemini_file_search" as const,
      storeResourceName: "fileSearchStores/approved", state: "published" as const,
      contentDigestSha256: "digest", approvalReference: "approval-1", publishedAt: now.toISOString() },
    intentCatalogVersionId: null, offeringCatalogVersionId: null,
  };
  return {
    requestId: "req-1", acceptedCustomerMessageId: "msg-1", agent,
    session: { sessionId: "sess-1", agentId: agent.agentId, ticketId: "ticket-1",
      agentVersionId: agent.agentVersionId, knowledgeVersionId: "kb-v1",
      intentCatalogVersionId: null, offeringCatalogVersionId: null, status: "active",
      createdAt: now.toISOString(), lastAcceptedCustomerMessageAt: now.toISOString(),
      expiresAt: future, providerContinuation: null },
    currentSessionHistory: [], customerMessage: "What are the licensing requirements?",
    allowedBuiltinTools: ["file_search"], allowedBusinessToolNames: ["find_intents"], deadlineMs: 5000,
    ...patch,
  };
}
function response(text = "Hello", chunks: unknown[] = []): unknown {
  return { candidates: [{ finishReason: "STOP", content: {role:"model", parts: [{text}]},
    groundingMetadata: { groundingChunks: chunks } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 } };
}
function calls(ids = ["call-1"]): unknown {
  return { candidates:[{finishReason:"STOP",content:{role:"model",parts: ids.map(id => ({
    functionCall:{id,name:"find_intents",args:{query:"company setup"}},thoughtSignature:"opaque-signature"
  }))}}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:7}};
}
class Store implements PendingFunctionStore {
  private states = new Map<string, PendingFunctionState>();
  async save(state: PendingFunctionState): Promise<string> {
    const ref = `durable-pending-${this.states.size + 1}`;
    this.states.set(ref, state); return ref;
  }
  async take(ref: string): Promise<PendingFunctionState | null> {
    const state = this.states.get(ref) ?? null; this.states.delete(ref); return state;
  }
}
function fake(outputs: unknown[] = [response()]): {client: GeminiGenerateClient; received: unknown[]} {
  const received: unknown[] = []; let count=0;
  return { received, client: {models: {generateContent: async arg => {
    received.push(arg); const out = outputs[count++];
    if (out instanceof Error) throw out;
    if (out instanceof Promise) return out;
    return out;
  }}}};
}
function make(client:GeminiGenerateClient, store?:Store, extra:Record<string,unknown> = {}) {
  return new GeminiModelAdapter(client, { pendingStore:store, declarations: () => [{
    name:"find_intents",description:"Find intents", parameters:{type:"object",properties:{query:{type:"string"}}}
  }], ...extra });
}
function expectFailure(out: Awaited<ReturnType<GeminiModelAdapter["runTurn"]>>, code: string) {
  assert.equal(out.kind,"failure"); if (out.kind==="failure") assert.equal(out.code,code);
}

test("greeting without retrieval or Google tools", async()=>{
  const f=fake(); const adapter=make(f.client);
  const out=await adapter.runTurn(request({customerMessage:"Hello"}),{phase:"functions"});
  assert.equal(out.kind,"candidate");
  const cfg=(f.received[0] as {config:{tools:unknown[]}}).config;
  assert.deepEqual(Object.keys(cfg.tools?.[0]??{}),["functionDeclarations"]);
  assert.ok(!JSON.stringify(f.received).includes("googleSearch"));
  assert.ok(!JSON.stringify(f.received).includes("urlContext"));
});

test("File Search uses only assigned approved store and preserves citations", async()=>{
  const f=fake([response("A license is needed",[{retrievedContext:{
    fileSearchStore:"fileSearchStores/approved", title:"License document", uri:"gs://exact-doc",
    text:"The license is required",pageNumber:2
  }}])]);
  const out=await make(f.client).runTurn(request());
  assert.equal(out.kind,"candidate");
  if(out.kind==="candidate") {
    assert.equal(out.candidate.sourceAnnotations[0]?.sourceTitle,"License document");
    assert.equal(out.candidate.sourceAnnotations[0]?.providerResourceName,null,"A store ID is not a document ID");
    assert.equal(out.candidate.sourceAnnotations[0]?.locator,"page:2");
    assert.equal(out.candidate.usage.inputTokens,12);
  }
  assert.deepEqual((f.received[0] as {config:{tools:unknown}}).config.tools,
    [{fileSearch:{fileSearchStoreNames:["fileSearchStores/approved"]}}]);
});

test("only exact document resource is used as evidence identity",async()=>{
  const f=fake([response("Supported",[{retrievedContext:{
    fileSearchStore:"fileSearchStores/approved",
    uri:"fileSearchStores/approved/documents/doc-123",text:"The approved document",
  }}])]);
  const out=await make(f.client).runTurn(request());
  assert.equal(out.kind,"candidate");
  if(out.kind==="candidate")assert.equal(out.candidate.sourceAnnotations[0]?.providerResourceName,
    "fileSearchStores/approved/documents/doc-123");
});

test("unknown source provenance is not fabricated",async()=>{
  const f=fake([response("Quoted",[{retrievedContext:{title:"Untyped document",text:"Evidence"}}])]);
  const out=await make(f.client).runTurn(request());
  if(out.kind==="candidate") assert.equal(out.candidate.sourceAnnotations[0]?.providerResourceName,null);
  else assert.fail("unexpected failure");
});

test("missing citation metadata remains absent",async()=>{
  const out=await make(fake().client).runTurn(request());
  if(out.kind==="candidate") assert.deepEqual(out.candidate.sourceAnnotations,[]);
  else assert.fail("unexpected failure");
});

test("foreign File Search store citation rejected",async()=>{
  const f=fake([response("Wrong",[{retrievedContext:{fileSearchStore:"fileSearchStores/foreign",text:"foreign"}}])]);
  expectFailure(await make(f.client).runTurn(request()),"TOOL_NOT_AUTHORIZED");
});

test("web search grounding is rejected even when SDK produces it",async()=>{
  const f=fake([response("Wrong",[{web:{uri:"https://search.example"}}])]);
  expectFailure(await make(f.client).runTurn(request()),"MODEL_OUTPUT_INVALID");
});

test("missing published knowledge when search requested rejected", async()=>{
  const q=request(); const f=fake();
  expectFailure(await make(f.client).runTurn(request({agent:{...q.agent,knowledge:null},session:{...q.session,knowledgeVersionId:null}})),"TOOL_NOT_AUTHORIZED");
  assert.equal(f.received.length,0);
});

test("draft/unapproved knowledge refused",async()=>{
  const q=request(); const f=fake();
  expectFailure(await make(f.client).runTurn(request({agent:{...q.agent,knowledge:{...q.agent.knowledge!,state:"draft"}}})),"TOOL_NOT_AUTHORIZED");
  assert.equal(f.received.length,0);
});

test("malformed model output rejected",async()=>{
  expectFailure(await make(fake([{candidates:[]}]).client).runTurn(request()),"MODEL_OUTPUT_INVALID");
});

test("forbidden builtin Google Search/URL Context blocked before provider call",async()=>{
  const f=fake(); const q=request();
  for(const tool of ["google_search","url_context","google_maps","code_execution"]) {
    const unsafe={...q,allowedBuiltinTools:[tool]} as unknown as ModelTurnRequest;
    expectFailure(await make(f.client).runTurn(unsafe),"TOOL_NOT_AUTHORIZED");
  }
  assert.equal(f.received.length,0);
});

test("unknown business tool and unapproved published tool blocked",async()=>{
  const f=fake(); const q=request();
  expectFailure(await make(f.client).runTurn({...q,allowedBusinessToolNames:["custom_shell" as never]}),"TOOL_NOT_AUTHORIZED");
  expectFailure(await make(f.client).runTurn({...q,allowedBusinessToolNames:["propose_operation"]}),"TOOL_NOT_AUTHORIZED");
  assert.equal(f.received.length,0);
});

test("duplicate model function call ids rejected",async()=>{
  const f=fake([calls(["call-1","call-1"])]);
  expectFailure(await make(f.client,new Store()).runTurn(request(),{phase:"functions"}),"TOOL_NOT_AUTHORIZED");
});

test("unknown function call rejected",async()=>{
  const f=fake([{candidates:[{content:{role:"model",parts:[{functionCall:{id:"abc",name:"execute_payment",args:{}}}]}}]}]);
  expectFailure(await make(f.client,new Store()).runTurn(request(),{phase:"functions"}),"TOOL_NOT_AUTHORIZED");
});

test("model arguments cannot alter trusted scope",async()=>{
  const f=fake([{candidates:[{content:{role:"model",parts:[{functionCall:{id:"abc",name:"find_intents",args:{agentId:"foreign"}}}]}}]}]);
  expectFailure(await make(f.client,new Store()).runTurn(request(),{phase:"functions"}),"TOOL_NOT_AUTHORIZED");
});

test("max call size enforced",async()=>{
  const f=fake([{candidates:[{content:{role:"model",parts:[{functionCall:{id:"a",name:"find_intents",args:{query:"X".repeat(9000)}}}]}}]}]);
  expectFailure(await make(f.client,new Store()).runTurn(request(),{phase:"functions"}),"TOOL_NOT_AUTHORIZED");
});

test("function results continue with exact call id and preserved thought signature",async()=>{
  const store=new Store(); const f=fake([calls(),response("We can help")]);
  const adapter=make(f.client,store); const q=request();
  const out=await adapter.runTurn(q,{phase:"functions"});
  assert.equal(out.kind,"candidate"); if(out.kind!=="candidate")return;
  assert.equal(out.candidate.functionCalls[0]?.callId,"call-1");
  assert.equal(out.candidate.continuation?.opaqueRef,null);
  assert.ok(out.candidate.continuation?.pendingToolStateRef);
  const ref=out.candidate.continuation!.pendingToolStateRef!;
  const next=await adapter.continueWithFunctionOutputs(q,ref,[{callId:"call-1",outputJson:'{"ok":true,"data":{"intents":[]}}'}]);
  assert.equal(next.kind,"candidate");
  if(next.kind==="candidate") assert.equal(next.candidate.text,"We can help");
  const history=(f.received[1] as {contents:GeminiContent[]}).contents;
  assert.equal((history[1].parts[0] as {thoughtSignature:string}).thoughtSignature,"opaque-signature");
  assert.deepEqual((history[2].parts[0] as {functionResponse:{id:string}}).functionResponse.id,"call-1");
  expectFailure(await adapter.continueWithFunctionOutputs(q,ref,[{callId:"call-1",outputJson:"{}"}]),"TOOL_CONTINUATION_INVALID");
});

test("continuation rejects cross-session and missing result without provider call",async()=>{
  const store=new Store(); const f=fake([calls()]); const adapter=make(f.client,store); const q=request();
  const out=await adapter.runTurn(q,{phase:"functions"}); if(out.kind!=="candidate")return assert.fail();
  const ref=out.candidate.continuation?.pendingToolStateRef!;
  expectFailure(await adapter.continueWithFunctionOutputs({...q,session:{...q.session,sessionId:"other"}},ref,[]),"TOOL_CONTINUATION_INVALID");
  assert.equal(f.received.length,1);
});

test("function round limit fails closed",async()=>{
  const store=new Store(); const f=fake([calls()]);
  expectFailure(await make(f.client,store,{maxRounds:1}).runTurn(request(),{phase:"functions"}),"TOOL_CONTINUATION_INVALID");
});

test("combined tools require explicit successful G1 certification",async()=>{
  const f=fake();
  expectFailure(await make(f.client,new Store()).runTurn(request(),{phase:"combined"}),"MODEL_OUTPUT_INVALID");
  assert.equal(f.received.length,0);
});

test("provider 429, 5xx and authentication classifications",async()=>{
  for(const [status, retryable] of [[429,true],[503,true],[401,false],[403,false]] as const) {
    const error=Object.assign(new Error("provider error"),{status});
    const out=await make(fake([error]).client).runTurn(request());
    expectFailure(out,"MODEL_UNAVAILABLE");
    if(out.kind==="failure") assert.equal(out.retryable,retryable);
  }
});

test("provider deadline and external cancellation",async()=>{
  const api:GeminiGenerateClient={models:{generateContent:async ({config})=>new Promise((_,reject)=>{
    config.abortSignal.addEventListener("abort",()=>reject(Object.assign(new Error("aborted"),{name:"AbortError"})),{once:true});
  })}};
  const adapter=make(api);
  const short=request({deadlineMs:10});
  expectFailure(await adapter.runTurn(short),"MODEL_TIMEOUT");
  const controller=new AbortController();controller.abort();
  expectFailure(await adapter.runTurn(request(),{signal:controller.signal}),"MODEL_TIMEOUT");
});

test("published persona and model selected from Node binding",async()=>{
  const f=fake();await make(f.client).runTurn(request());
  const q=f.received[0] as {model:string;config:{systemInstruction:string}};
  assert.equal(q.model,"gemini-2.5-flash");
  assert.match(q.config.systemInstruction,/You are Sara/);
  assert.match(q.config.systemInstruction,/Never use web search/);
});

test("no business handler execution or side effect in adapter",async()=>{
  let executed=0;
  const f=fake([calls()]); const adapter=new GeminiModelAdapter(f.client,{
    pendingStore:new Store(), declarations:()=>[{name:"find_intents",description:"lookup",parameters:{type:"object"}}],
    ...{execute:()=>executed++},
  });
  const out=await adapter.runTurn(request(),{phase:"functions"});
  assert.equal(out.kind,"candidate");assert.equal(executed,0);
});

test("schema-invalid function arguments rejected before business execution",async()=>{
  const bad={candidates:[{content:{role:"model",parts:[{functionCall:{
    id:"call-1",name:"find_intents",args:{query:27}
  }}]}}]};
  const f=fake([bad]);
  const adapter=new GeminiModelAdapter(f.client,{pendingStore:new Store(),
    declarations:()=>[{name:"find_intents",description:"Find intent",parameters:{
      type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false
    }}]});
  expectFailure(await adapter.runTurn(request(),{phase:"functions"}),"TOOL_NOT_AUTHORIZED");
});

test("multi-turn history is carried only from supplied current session",async()=>{
  const q=request({currentSessionHistory:[
    {role:"customer",text:"I need an IT trade license",sourceMessageId:"m1"},
    {role:"assistant",text:"How many visas?",sourceMessageId:"m2"}
  ],customerMessage:"Two visas"});
  const f=fake(); const out=await make(f.client).runTurn(q);
  assert.equal(out.kind,"candidate");
  assert.deepEqual((f.received[0] as {contents:GeminiContent[]}).contents.map(x=>x.parts[0]?.text),
    ["I need an IT trade license","How many visas?","Two visas"]);
});

test("unsupported factual question receives no fabricated citations",async()=>{
  const f=fake([response("I do not have approved evidence for that claim.")]);
  const out=await make(f.client).runTurn(request());
  assert.equal(out.kind,"candidate");
  if(out.kind==="candidate") {
    assert.deepEqual(out.candidate.sourceAnnotations,[]);
    assert.equal(out.candidate.continuation,null);
  }
});

test("expired session denied before model invocation",async()=>{
  const f=fake();const q=request();
  expectFailure(await make(f.client).runTurn(request({session:{...q.session,expiresAt:new Date(0).toISOString()}})),"MODEL_OUTPUT_INVALID");
  assert.equal(f.received.length,0);
});