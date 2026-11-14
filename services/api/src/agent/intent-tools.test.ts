import test from "node:test";
import assert from "node:assert/strict";
import { AgentToolRegistry } from "./tool-registry.js";
import { registerIntentTools, type IntentEntry } from "./intent-tools.js";

function setup(){
  const registry=new AgentToolRegistry();
  const intents:IntentEntry[]=Array.from({length:21},(_,i)=>({
    key:"intent_"+i,name:"Service "+i,
    description:"Business service category "+i,
    examplePhrases:["Task example "+i],
    requirements:[],allowedActions:["create_enquiry"],
  }));
  registerIntentTools(registry,{
    async listIntents(){return intents;},
    async listOfferings(){return [];},
  },{
    async listFacts(){return [];},
    async recordCustomerFacts(){return [];},
  },{
    async selectIntent(){return {intentKey:"intent_0",status:"active"};},
  });
  const context={agentId:"11111111-1111-4111-8111-111111111111",
    ticketId:"22222222-2222-4222-8222-222222222222",
    principalId:"ticket:test",sourceCustomerMessageId:"33333333-3333-4333-8333-333333333333",
    intentCatalogRevision:"1",offeringCatalogRevision:"1",
    authorizedToolNames:new Set(["find_intents"] as const)};
  return {registry,context};
}
test("unknown wording never eliminates any of the 21 published intents",async()=>{
  const {registry,context}=setup();
  const result=await registry.execute({callId:"a",name:"find_intents",
    argumentsJson:JSON.stringify({query:"utterly unrelated vocabulary"})},context);
  assert.equal(result.ok,true);
  if(!result.ok)return;
  const data=result.data as {total:number;candidates:Array<{intentKey:string}>;hasMore:boolean};
  assert.equal(data.total,21);
  assert.equal(data.candidates.length,21);
  assert.equal(new Set(data.candidates.map(i=>i.intentKey)).size,21);
  assert.equal(data.hasMore,false);
});
test("catalog paging covers large future catalogs and enforces bounds",async()=>{
  const {registry,context}=setup();
  const result=await registry.execute({callId:"b",name:"find_intents",
    argumentsJson:JSON.stringify({query:"company setup",limit:10,offset:10})},context);
  assert.equal(result.ok,true);
  if(!result.ok)return;
  const data=result.data as {total:number;candidates:unknown[];hasMore:boolean;nextOffset:number|null};
  assert.equal(data.total,21);
  assert.equal(data.candidates.length,10);
  assert.equal(data.hasMore,true);
  assert.equal(data.nextOffset,20);
  const invalid=await registry.execute({callId:"c",name:"find_intents",
    argumentsJson:JSON.stringify({query:"company setup",limit:500})},context);
  assert.equal(invalid.ok,false);
});
test("unpublished model tools are never callable",async()=>{
  const {registry,context}=setup();
  const result=await registry.execute({callId:"d",name:"propose_operation",
    argumentsJson:JSON.stringify({intentKey:"intent_0",actionKey:"create_enquiry"})},context);
  assert.deepEqual(result,{ok:false,error:{
    code:"TOOL_NOT_AUTHORIZED",message:"Tool unavailable"}});
});
