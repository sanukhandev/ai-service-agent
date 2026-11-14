#!/usr/bin/env node
/**
 * Private, operator-initiated existing-workflow upgrader.
 * Keeps IDs, owner workspace and encrypted credentials unchanged.
 * Requires the two payment workflows to be inactive.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const DEFINITIONS=[
  {
    file:"03-mockgateway-payment-link.json",
    oldName:"ANCFZ | MockGateway Demo Order Request (checkout URL if provided)",
    newName:"ANCFZ | 2Checkout Mock Order Create",path:"ancfz/payment-link",
    oldNode:"MockGateway Demo Orders POST",
    newNode:"2Checkout Mock Orders POST",
  },
  {
    file:"04-mockgateway-payment-verify.json",
    oldName:"ANCFZ | MockGateway Demo Orders Status (Fail Closed Until Verified)",
    newName:"ANCFZ | 2Checkout Mock Payment Verification",path:"ancfz/payment-verify",
    oldNode:"Reject Unverified Demo Order",newNode:"2Checkout Mock GET Order",
  },
];
const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
async function inputJson(){
  let s="";
  for await(const c of process.stdin){
    s+=c.toString("utf8");if(s.length>8192)fail("INVALID_INPUT","Input too large");
  }
  const v=JSON.parse(s);
  if(!v||!["inspect","snapshot","apply"].includes(v.action) ||
    typeof v.apiKey!=="string"||v.apiKey.length<16)
    fail("INVALID_INPUT","Private API key and action required");
  return v;
}
function apiClient(secret){
  const prefix=String(process.env.N8N_PATH||"/").replace(/^\/+|\/+$/g,"");
  const roots=[...new Set(["/api/v1",...(prefix?["/"+prefix+"/api/v1"]:[])])];
  let selected=null;
  return async(method,path,data)=>{
    const options=selected?[selected]:roots;
    for(let i=0;i<options.length;i++){
      const root=options[i];
      let res;
      try{
        res=await fetch(new URL(root+path,"http://127.0.0.1:5678"),{
          method,headers:{
            "X-N8N-API-KEY":secret,Accept:"application/json",
            ...(data?{"Content-Type":"application/json"}:{}),
          },
          ...(data?{body:JSON.stringify(data)}:{}),
          signal:AbortSignal.timeout(15000),
        });
      }catch{fail("API_UNAVAILABLE","n8n public API unreachable");}
      if(res.status===404 && method==="GET"&&!selected && i<options.length-1)continue;
      if(!res.ok){
        if(res.status===401)fail("API_UNAUTHORIZED","n8n API key not valid");
        if(res.status===403)fail("API_FORBIDDEN","n8n API key lacks workflow read/update permission");
        fail("API_HTTP_ERROR","n8n "+method+" workflow API returned "+res.status);
      }
      selected=root;
      try{return res.status===204?{}:await res.json();}
      catch{fail("API_INVALID_RESPONSE","n8n workflow API returned invalid JSON");}
    }
    fail("API_ENDPOINT_UNAVAILABLE","n8n workflow API unavailable");
  };
}
async function listWorkflows(api){
  const found=[];let cursor=null;const cursors=new Set();
  for(let page=0;page<40;page++){
    const v=await api("GET","/workflows?limit=250"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
    if(!Array.isArray(v.data))fail("API_INVALID_RESPONSE","Unexpected workflow list format");
    found.push(...v.data);
    cursor=v.nextCursor||null;
    if(!cursor)return found;
    if(typeof cursor!=="string"||cursors.has(cursor))fail("API_INVALID_RESPONSE","Invalid pagination");
    cursors.add(cursor);
  }
  fail("API_INVALID_RESPONSE","Workflow pagination limit exceeded");
}
function bodyFor(template,existing){
  // Replacing a Webhook node with a new webhookId can break n8n registration.
  // Carry forward the n8n-assigned webhookId from the existing workflow.
  const prior=(existing.nodes||[]).find(n=>n.type==="n8n-nodes-base.webhook");
  const nodes=structuredClone(template.nodes);
  const trigger=nodes.find(n=>n.type==="n8n-nodes-base.webhook");
  if(prior?.webhookId && trigger)trigger.webhookId=prior.webhookId;
  return {
    name:template.name,nodes,
    connections:template.connections,settings:template.settings,
  };
}
function fingerprint(wf){
  return createHash("sha256").update(JSON.stringify({
    name:wf.name,active:wf.active,nodes:wf.nodes,
    connections:wf.connections,settings:wf.settings,
  })).digest("hex");
}
function credentialId(node){
  return node?.credentials?.httpHeaderAuth?.id;
}
function confirmExpectedBindings(detail,source,d){
  const expectedWeb="feb4e5dc-ae64-4ca8-bf87-dd1fae009fa1";
  const expectedMerchant="4d9487aa-e07b-4bfd-92b9-a9699ffb5e45";
  const web=detail.nodes.find(n=>n.type==="n8n-nodes-base.webhook");
  const sourceWeb=source.nodes.find(n=>n.type==="n8n-nodes-base.webhook");
  if(credentialId(web)!==expectedWeb || credentialId(sourceWeb)!==expectedWeb)
    fail("CREDENTIAL_CONFLICT","Existing webhook credential binding differs: "+d.path);
  const merchant=detail.nodes.find(n=>n.name===d.oldNode||n.name===d.newNode);
  const sourceMerchant=source.nodes.find(n=>n.name===d.newNode);
  // The historical verification workflow was intentionally fail-closed and
  // had no gateway HTTP node or merchant credential. That is expected pre-upgrade.
  const isLegacyVerifier=d.oldNode==="Reject Unverified Demo Order" &&
    !detail.nodes.some(n=>n.name===d.newNode);
  if(credentialId(sourceMerchant)!==expectedMerchant ||
     (!isLegacyVerifier && credentialId(merchant)!==expectedMerchant))
    fail("CREDENTIAL_CONFLICT","Merchant credential binding differs: "+d.path);
}
function assertUpgradedMatches(detail,source,d){
  const byName=new Map((detail.nodes||[]).map(n=>[n.name,n]));
  for(const expected of source.nodes){
    const actual=byName.get(expected.name);
    if(!actual||actual.type!==expected.type)
      fail("SOURCE_DRIFT","n8n workflow nodes differ from reviewed source: "+d.path);
    if(expected.type==="n8n-nodes-base.code" &&
       actual.parameters?.jsCode!==expected.parameters?.jsCode)
      fail("SOURCE_DRIFT","n8n Code node differs from reviewed source: "+d.path);
    if(expected.type==="n8n-nodes-base.httpRequest" &&
       JSON.stringify(actual.parameters)!==JSON.stringify(expected.parameters))
      fail("SOURCE_DRIFT","n8n gateway HTTP node differs from reviewed source: "+d.path);
  }
  if(byName.size!==source.nodes.length||
     JSON.stringify(detail.connections)!==JSON.stringify(source.connections)||
     detail.settings?.saveDataSuccessExecution!=="none"||
     detail.settings?.saveDataErrorExecution!=="none")
    fail("SOURCE_DRIFT","n8n payment graph/settings differ from reviewed source: "+d.path);
}
function webhookPath(wf){
  const triggers=(wf.nodes||[]).filter(n=>n.type==="n8n-nodes-base.webhook");
  return triggers.length===1?triggers[0].parameters?.path:null;
}
async function main(){
  const v=await inputJson();
  if(process.env.APP_ENV!=="development")
    fail("DISABLED","2Checkout mock upgrade is permitted only on development n8n");
  const api=apiClient(v.apiKey.trim());
  const all=await listWorkflows(api);
  const plan=[];
  for(const d of DEFINITIONS){
    const matches=all.filter(w=>w.name===d.oldName||w.name===d.newName);
    if(matches.length!==1)fail("WORKFLOW_CONFLICT","Expected exactly one existing workflow: "+d.path);
    const summary=matches[0];
    if(summary.active!==false)fail("WORKFLOW_ACTIVE","Deactivate the payment workflow before upgrading: "+d.path);
    const detail=await api("GET","/workflows/"+encodeURIComponent(summary.id));
    if(webhookPath(detail)!==d.path)fail("WORKFLOW_CONFLICT","Unexpected webhook path: "+d.path);
    const trigger=detail.nodes.find(n=>n.type==="n8n-nodes-base.webhook");
    if(trigger?.parameters?.authentication!=="headerAuth")fail("WORKFLOW_CONFLICT","Private webhook header auth is missing");
    const source=JSON.parse(readFileSync(new URL(d.file,import.meta.url),"utf8"));
    const before=summary.name===d.oldName;
    if(before && !detail.nodes.some(n=>n.name===d.oldNode))
      fail("WORKFLOW_CONFLICT","Unexpected old workflow topology: "+d.path);
    if(!before && !detail.nodes.some(n=>n.name===d.newNode))
      fail("WORKFLOW_CONFLICT","Existing upgraded workflow has unexpected topology: "+d.path);
    const binding=(source.nodes||[]).flatMap(n=>Object.values(n.credentials||{}))
      .find(c=>c?.id==="4d9487aa-e07b-4bfd-92b9-a9699ffb5e45");
    if(!binding)fail("SOURCE_INVALID","Source workflow lost 2Checkout credential reference");
    confirmExpectedBindings(detail,source,d);
    if(!before)assertUpgradedMatches(detail,source,d);
    plan.push({d,id:summary.id,update:before,template:source,detail,hash:fingerprint(detail)});

  }
  const result={ok:true,workflows:plan.map(p=>({path:p.d.path,
    state:p.update?"legacy_needs_upgrade":"already_upgraded",active:false}))};
  if(v.action==="inspect")return result;
  if(v.action==="snapshot")return {...result,
    snapshot:plan.map(p=>({id:p.id,path:p.d.path,hash:p.hash,document:p.detail}))};
  if(!Array.isArray(v.expected)||v.expected.length!==plan.length)
    fail("BACKUP_REQUIRED","A verified local backup and matching snapshot are required before apply");
  for(const step of plan){
    const match=v.expected.find(x=>x?.id===step.id);
    if(!match||match.hash!==step.hash)
      fail("SNAPSHOT_CHANGED","Workflow changed since local backup; inspect and back up again");
  }
  for(const step of plan){
    if(!step.update)continue;
    const updated=await api("PUT","/workflows/"+encodeURIComponent(step.id),bodyFor(step.template,step.detail));
    if(updated?.id!==step.id || updated?.name!==step.d.newName)
      fail("UPDATE_UNCERTAIN","Workflow update result uncertain; inspect before retrying: "+step.d.path);
    const checked=await api("GET","/workflows/"+encodeURIComponent(step.id));
    if(checked.active!==false || checked.name!==step.d.newName ||
      webhookPath(checked)!==step.d.path)
      fail("UPDATE_UNCERTAIN","Workflow update not verified: "+step.d.path);
    confirmExpectedBindings(checked,step.template,step.d);
    const oldWebhook=step.detail.nodes.find(n=>n.type==="n8n-nodes-base.webhook")?.webhookId;
    const newWebhook=checked.nodes.find(n=>n.type==="n8n-nodes-base.webhook")?.webhookId;
    if(oldWebhook && newWebhook!==oldWebhook)
      fail("UPDATE_UNCERTAIN","n8n webhook ID was not preserved: "+step.d.path);
    assertUpgradedMatches(checked,step.template,step.d);
  }
  return {...result,applied:true};
}
try{
  process.stdout.write(JSON.stringify(await main())+"\n");
}catch(e){
  process.stdout.write(JSON.stringify({
    ok:false,code:typeof e?.code==="string"?e.code:"UPGRADE_FAILED",
    error:String(e?.message||"Workflow upgrade failed").replace(/2CO_[A-Za-z0-9]+/g,"[redacted]").slice(0,280),
  })+"\n");
}
