#!/usr/bin/env node
/**
 * Opt-in, billable G1 feasibility probe: synthetic data ONLY.
 * Must never index customer or ANCFZ business documents.
 * Generates a disposable Google File Search store and deletes it on exit.
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { GoogleFileSearchProvider } from "../services/api/dist/knowledge/provider.js";
import { validateSource } from "../services/api/dist/knowledge/intake.js";
import { createOfficialGeminiAdapter } from "../services/api/dist/gemini/adapter.js";

function fail(code){throw new Error("G1_"+code);}
if(process.env.GEMINI_G1_ALLOW_BILLABLE_RUN!=="YES")fail("EXPLICIT_BILLABLE_OPT_IN_REQUIRED");
const apiKey=process.env.GEMINI_API_KEY;
if(!apiKey)fail("API_KEY_MISSING");
const model=process.env.GEMINI_G1_MODEL_ID||"gemini-3.8-flash";
if(!/^[a-zA-Z0-9_.-]+$/.test(model))fail("INVALID_MODEL");
const uid=randomUUID();
const agentId=randomUUID(),knowledgeVersionId=randomUUID();
const documentId=randomUUID(),documentVersionId=randomUUID();
const phrase="The fictional G1 Nebula-472 license requires exactly seven green seals. This synthetic statement is for API testing only.";
const document=validateSource("gemini-g1-synthetic.txt",Buffer.from(phrase,"utf8"));
const sourceMetadata={agentId,knowledgeVersionId,documentId,documentVersionId,sha256:document.sha256};
const provider=new GoogleFileSearchProvider(apiKey);
let store=null,documentName=null;
class EphemeralToolState {
  privateStates=new Map();
  async save(value){const id=randomUUID();this.privateStates.set(id,value);return id;}
  async take(id){const value=this.privateStates.get(id)??null;this.privateStates.delete(id);return value;}
}
const report={model,greeting:false,positiveRetrieval:false,approvedCitation:false,
  customMetadata:false,authorizedFunction:false,webToolsAdvertised:false,cleanup:false};
try {
  store=await provider.createStore("gemini-g1-synthetic-"+uid);
  const operation=await provider.upload(store,document,sourceMetadata);
  let current=operation;
  for(let tries=0;tries<60 && !current.done;tries++){
    await sleep(2000);
    current=await provider.operation(operation.name);
  }
  if(!current.done||current.error)fail("INDEXING_FAILED");
  for(let tries=0;tries<30;tries++){
    const documents=await provider.listDocuments(store);
    const expected=documents.filter(d=>{
      const meta=Object.fromEntries((d.customMetadata??[]).map(v=>[v.key,v.stringValue]));
      return Object.entries(sourceMetadata).every(([k,v])=>meta[k]===v);
    });
    if(expected.length===1 && expected[0].state==="STATE_ACTIVE"){
      documentName=expected[0].name;break;
    }
    await sleep(2000);
  }
  if(!documentName)fail("INDEXED_DOCUMENT_NOT_ACTIVE");
  const retrieval=await provider.retrieve(model,store,"How many green seals does the fictional Nebula-472 license require?");
  report.positiveRetrieval=retrieval.text.trim().length>0;
  report.approvedCitation=retrieval.documentResources.includes(documentName);
  if(!report.positiveRetrieval||!report.approvedCitation)fail("RETRIEVAL_CITATION_UNVERIFIED");
  report.customMetadata=retrieval.rawAnnotations.some(c=>{
    const md=c?.retrievedContext?.customMetadata;
    return Array.isArray(md)&&md.some(x=>x.key==="documentVersionId"&&x.stringValue===documentVersionId);
  });
  const pendingStore=new EphemeralToolState();
  const adapter=await createOfficialGeminiAdapter(apiKey,{
    declarations:()=>[{name:"find_intents",description:"Find intent catalog entries by query",
      parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}],
    pendingStore,combinedToolsLiveVerified:false,maxRounds:2,maxCalls:2,
  });
  const agent={agentId,agentVersionId:randomUUID(),provider:"gemini",modelId:model,
    personaVersion:"g1-synthetic",systemInstructions:"You are an assistant evaluating a synthetic document. Never browse the web.",
    authorizedToolNames:["find_intents"],knowledge:{agentId,knowledgeVersionId,provider:"gemini_file_search",
      storeResourceName:store,state:"published",contentDigestSha256:document.sha256,
      approvalReference:"synthetic-g1",publishedAt:new Date().toISOString()},
    intentCatalogVersionId:null,offeringCatalogVersionId:null};
  const session={sessionId:randomUUID(),agentId,ticketId:randomUUID(),
    agentVersionId:agent.agentVersionId,knowledgeVersionId,intentCatalogVersionId:null,
    offeringCatalogVersionId:null,status:"active",createdAt:new Date().toISOString(),
    lastAcceptedCustomerMessageAt:new Date().toISOString(),
    expiresAt:new Date(Date.now()+3600000).toISOString(),providerContinuation:null};
  const baseRequest={requestId:randomUUID(),acceptedCustomerMessageId:randomUUID(),
    agent,session,currentSessionHistory:[],deadlineMs:30000};
  const greeting=await adapter.runTurn({...baseRequest,customerMessage:"Hello",allowedBuiltinTools:[],
    allowedBusinessToolNames:[]},{phase:"functions"});
  report.greeting=greeting.kind==="candidate"&&greeting.candidate.text.trim().length>0;
  if(!report.greeting)fail("GEMINI_GREETING_FAILED");
  const answer=await adapter.runTurn({...baseRequest,requestId:randomUUID(),
    acceptedCustomerMessageId:randomUUID(),
    customerMessage:"How many green seals does the fictional Nebula-472 license require?",
    allowedBuiltinTools:["file_search"],allowedBusinessToolNames:[]},{phase:"knowledge"});
  if(answer.kind!=="candidate")fail("ADAPTER_KNOWLEDGE_CALL_FAILED");
  const seen=answer.candidate.sourceAnnotations;
  if(!seen.length)fail("ADAPTER_CITATION_MISSING");
  // Both direct document-resource and metadata-derived citations are valid
  // inputs to Node's independent authority check (not approved by themselves).
  if(!seen.some(c=>c.providerResourceName===documentName ||
    c.sourceMetadata?.documentVersionId===documentVersionId))
    fail("ADAPTER_CITATION_IDENTITY_UNVERIFIED");
  const intent=await adapter.runTurn({...baseRequest,requestId:randomUUID(),
    acceptedCustomerMessageId:randomUUID(),
    customerMessage:"Use the find_intents function to search query 'company setup' now.",
    allowedBuiltinTools:[],allowedBusinessToolNames:["find_intents"]},{phase:"functions"});
  report.authorizedFunction=intent.kind==="candidate" &&
    intent.candidate.functionCalls.some(x=>x.name==="find_intents");
  if(!report.authorizedFunction)fail("FUNCTION_CALL_NOT_PROVEN");
  // Emit PASS only after the finally cleanup attempt completes.
} finally {
  if(store){
    try{
      const documents=await provider.listDocuments(store);
      for(const d of documents)await provider.deleteDocument(d.name);
      await provider.deleteStore(store);
      report.cleanup=true;
    }catch{
      // This is the only exceptional place a synthetic cloud store ID is
      // printed, so operators can remove an orphaned billable test resource.
      console.error("G1_SYNTHETIC_CLEANUP_FAILED: remove synthetic store",store);
    }
  }
}

if(!report.cleanup)fail("CLEANUP_UNVERIFIED");
process.stdout.write(JSON.stringify({status:"G1_LIVE_COMPATIBILITY_PASS",...report},null,2)+"\\n");
