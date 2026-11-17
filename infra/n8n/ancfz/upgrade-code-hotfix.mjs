#!/usr/bin/env node
/**
 * Guarded hotfix of exactly three pre-existing n8n workflows in the same owner workspace.
 * Never creates a workflow, overwrites credentials, changes owner/encryption key,
 * activates a workflow, or posts to Salesforce/MockGateway.
 *
 * Actions: inspect, snapshot, apply. Requires private owner API key via stdin.
 * For apply: workflows must be unpublished/inactive, and the exact snapshot
 * hash must match the live definition immediately before update.
 */
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";

const specs=[
  {file:"01-salesforce-lead.json",name:"ANCFZ | Salesforce Apex REST AI Chatbot Lead",
    path:"ancfz/salesforce-lead",targets:[
      "Validate ANCFZ Lead","Salesforce Apex REST Create Lead","Inspect Apex REST Lead Result",
    ]},
  {file:"03-mockgateway-payment-link.json",name:"ANCFZ | 2Checkout Mock Order Create",
    path:"ancfz/payment-link",targets:["Inspect Demo Order Response"]},
  {file:"04-mockgateway-payment-verify.json",
    name:"ANCFZ | 2Checkout Mock Payment Verification",
    path:"ancfz/payment-verify",targets:[
      "Validate Verification Request","2Checkout Mock GET Order","Validate Gateway Status",
    ]},
];
const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
async function readInput(){
  let s="";
  for await(const chunk of process.stdin){
    s+=chunk.toString("utf8");
    if(s.length>12000)fail("INVALID_INPUT","Input too large");
  }
  let o;try{o=JSON.parse(s)}catch{fail("INVALID_INPUT","Invalid JSON");}
  if(!o||!["inspect","snapshot","apply"].includes(o.action)||
    typeof o.apiKey!=="string"||o.apiKey.length<16)
    fail("INVALID_INPUT","Action and owner API key required");
  return o;
}
function apiClient(secret){
  const prefix=String(process.env.N8N_PATH||"/").replace(/^\/+|\/+$/g,"");
  const roots=[...new Set(["/api/v1",...(prefix?["/"+prefix+"/api/v1"]:[])])];
  let selected=null;
  return async(method,path,body)=>{
    const rootsToTry=selected?[selected]:roots;
    for(let i=0;i<rootsToTry.length;i++){
      let res;
      try{
        res=await fetch(new URL(rootsToTry[i]+path,"http://127.0.0.1:5678"),{
          method,headers:{"X-N8N-API-KEY":secret,"Accept":"application/json",
            ...(body?{"Content-Type":"application/json"}:{})},
          ...(body?{body:JSON.stringify(body)}:{}),
          signal:AbortSignal.timeout(15000),
        });
      }catch{fail("API_UNAVAILABLE","n8n owner API not reachable");}
      if(res.status===404&&method==="GET"&&!selected&&i<rootsToTry.length-1)continue;
      if(!res.ok){
        if(res.status===401)fail("API_UNAUTHORIZED","Owner n8n API key rejected");
        if(res.status===403)fail("API_FORBIDDEN","Owner API key lacks workflow permission");
        fail("API_HTTP_"+res.status,"n8n API rejected workflow request");
      }
      selected=rootsToTry[i];
      try{return res.status===204?{}:await res.json()}
      catch{fail("API_INVALID_RESPONSE","n8n returned non-JSON workflow metadata");}
    }
    fail("API_NOT_FOUND","n8n public API prefix unavailable");
  };
}
async function list(api){
  const all=[];let cursor=null;const seen=new Set();
  for(let page=0;page<40;page++){
    const response=await api("GET","/workflows?limit=250"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
    if(!Array.isArray(response.data))fail("API_INVALID_RESPONSE","Expected workflow list");
    all.push(...response.data);cursor=response.nextCursor??null;
    if(!cursor)return all;
    if(typeof cursor!=="string"||seen.has(cursor))fail("API_INVALID_RESPONSE","Invalid cursor");
    seen.add(cursor);
  }
  fail("API_INVALID_RESPONSE","Too many workflow pages");
}
function fingerprint(w){
  return createHash("sha256").update(JSON.stringify({
    name:w.name,active:w.active,nodes:w.nodes,connections:w.connections,settings:w.settings,
  })).digest("hex");
}
function hasKnownCode(target,existing,spec){
  if(target.name==="Validate ANCFZ Lead"){
    return existing.includes("Name:string(b.name??b.Name,'Name',120)")||
      existing.includes("const fullName=string(b.name??b.Name,'Name',120)");
  }
  if(target.name==="Inspect Apex REST Lead Result"){
    return existing.includes("const raw=$input.first().json;")||
      existing.includes("const envelope=$input.first().json;");
  }
  if(target.name==="Inspect Demo Order Response"){
    return existing.includes("new URL(urlText)")||
      existing.includes("n8n 2.x Code nodes do not expose the URL global");
  }
  if(target.name==="Validate Verification Request"){
    return existing.includes("Invalid 2Checkout order reference") &&
      existing.includes("Invalid authorized amount/currency");
  }
  if(target.name==="Validate Gateway Status"){
    return existing.includes("This runs after a FRESH authenticated GET") &&
      existing.includes("2Checkout order reference mismatch");
  }
  return false;
}
function validate(w,source,spec){
  if(w.name!==spec.name||!Array.isArray(w.nodes)||!w.connections)
    fail("WORKFLOW_CONFLICT","Unexpected workflow: "+spec.path);
  const trigger=w.nodes.find(x=>x.type==="n8n-nodes-base.webhook");
  if(!trigger||trigger.parameters?.path!==spec.path)
    fail("WORKFLOW_CONFLICT","Unexpected webhook path: "+spec.path);
  const expectedTrigger=source.nodes.find(x=>x.type==="n8n-nodes-base.webhook");
  if(trigger.credentials?.httpHeaderAuth?.id!==
     expectedTrigger.credentials?.httpHeaderAuth?.id)
    fail("CREDENTIAL_CONFLICT","Webhook credential changed: "+spec.path);
  const actualNames=w.nodes.map(n=>n.name).sort().join("|");
  const expectedNames=source.nodes.map(n=>n.name).sort().join("|");
  if(actualNames!==expectedNames)
    fail("SOURCE_DRIFT","Workflow node inventory changed: "+spec.path);
  const changes=[];
  for(const expected of source.nodes){
    const current=w.nodes.find(n=>n.name===expected.name);
    if(!current||current.type!==expected.type)
      fail("SOURCE_DRIFT","Workflow node type changed: "+spec.path);
    if(JSON.stringify(current.credentials??{})!==JSON.stringify(expected.credentials??{}))
      fail("CREDENTIAL_CONFLICT","Node credential binding differs: "+spec.path);
    if(spec.targets.includes(expected.name)){
      if(JSON.stringify(current.parameters)!==JSON.stringify(expected.parameters)){
        if(expected.type==="n8n-nodes-base.code"){
          if(!hasKnownCode(expected,current.parameters?.jsCode??"",spec))
            fail("SOURCE_DRIFT","Unexpected custom Code node: "+expected.name);
        }else if(expected.name==="Salesforce Apex REST Create Lead"){
          const old=structuredClone(expected.parameters);
          old.options={timeout:30000};
          if(JSON.stringify(current.parameters)!==JSON.stringify(old))
            fail("SOURCE_DRIFT","Unexpected Salesforce HTTP node config");
        }else if(expected.name==="2Checkout Mock GET Order"){
          const old=structuredClone(expected.parameters);
          old.url=old.url.replace("json.providerPaymentId","json.orderReference");
          if(JSON.stringify(current.parameters)!==JSON.stringify(old))
            fail("SOURCE_DRIFT","Unexpected MockGateway GET node config");
        }
        changes.push(expected.name);
      }
    }
  }
  return changes;
}
function updateBody(current,template,spec){
  const nodes=structuredClone(current.nodes);
  for(const name of spec.targets){
    const live=nodes.find(n=>n.name===name);
    const next=template.nodes.find(n=>n.name===name);
    // Preserve each node's ID, webhook registration, location and all secrets.
    live.parameters=structuredClone(next.parameters);
  }
  return {name:current.name,nodes,connections:current.connections,settings:current.settings};
}
async function main(){
  const request=await readInput();const api=apiClient(request.apiKey);
  const all=await list(api);const results=[];
  for(const spec of specs){
    const matches=all.filter(x=>x.name===spec.name);
    if(matches.length!==1)fail("WORKFLOW_CONFLICT","Expected exactly one workflow: "+spec.path);
    const w=await api("GET","/workflows/"+encodeURIComponent(matches[0].id));
    const template=JSON.parse(readFileSync(new URL(spec.file,import.meta.url),"utf8"));
    if(template.active!==false||template.name!==spec.name)
      fail("SOURCE_INVALID","Reviewed template must be inactive: "+spec.path);
    const changes=validate(w,template,spec);
    results.push({id:w.id,spec,template,w,changes,hash:fingerprint(w)});
  }
  if(request.action==="inspect"){
    return {ok:true,workflows:results.map(({id,spec,w,changes})=>({
      id,path:spec.path,active:w.active,
      status:changes.length?"needs_patch":"already_patched",changes,
    }))};
  }
  if(request.action==="snapshot"){
    return {ok:true,snapshot:results.map(({id,spec,w,hash})=>({
      id,path:spec.path,hash,document:w,
    }))};
  }
  if(!Array.isArray(request.expected)||request.expected.length!==results.length)
    fail("SNAPSHOT_REQUIRED","Expected exact workflow hash set");
  for(const x of results){
    // An already-patched active workflow is strictly read-only. Only workflow
    // definitions with actual parameter changes need to be unpublished.
    // This avoids pausing Salesforce when patching payment workflows.
    if(x.changes.length>0 && x.w.active!==false)
      fail("WORKFLOW_ACTIVE","Unpublish workflow needing a patch: "+x.spec.path);
    const match=request.expected.find(v=>v.id===x.id);
    if(!match||match.hash!==x.hash)
      fail("SNAPSHOT_CHANGED","Workflow changed since backup: "+x.spec.path);
  }
  for(const x of results){
    if(!x.changes.length)continue;
    const body=updateBody(x.w,x.template,x.spec);
    await api("PUT","/workflows/"+encodeURIComponent(x.id),body);
    const saved=await api("GET","/workflows/"+encodeURIComponent(x.id));
    if(saved.active!==false||validate(saved,x.template,x.spec).length)
      fail("UPDATE_NOT_VERIFIED","Workflow update could not be verified: "+x.spec.path);
  }
  return {ok:true,applied:true,workflows:results.map(({spec,changes})=>({
    path:spec.path,updated:changes.length>0,remainsInactive:true,
  }))};
}
main().then(x=>process.stdout.write(JSON.stringify(x)+"\n")).catch(e=>{
  // Never print workflow or secret-bearing response bodies.
  process.stdout.write(JSON.stringify({ok:false,code:e.code||"HOTFIX_FAILED",
    error:String(e.message||"Workflow update stopped").slice(0,180)})+"\n");
  process.exitCode=1;
});
