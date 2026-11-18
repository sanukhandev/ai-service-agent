#!/usr/bin/env node
/** Private n8n-only opt-in contract registry installer. Do not log API keys. */
const TABLE="ANCFZ_POC_CONTRACTS";
const WORKFLOW="ANCFZ | MOCK Contract Registry (LOCAL ONLY)";
const columns=[
  {name:"contractId",type:"string"},
  {name:"contractNumber",type:"string"},
  {name:"revision",type:"number"},
  {name:"ticketId",type:"string"},
  {name:"quoteNumber",type:"string"},
  {name:"invoiceNumber",type:"string"},
  {name:"status",type:"string"},
];
class SetupError extends Error{constructor(code,message){super(message);this.code=code;}}
function fail(code,message){throw new SetupError(code,message);}
async function input(){let data="";for await(const chunk of process.stdin){
  data+=chunk.toString("utf8");if(data.length>8192)fail("INVALID_INPUT","Input too large");
}return JSON.parse(data);}
function apiClient(key){
  const base="http://127.0.0.1:5678";
  const prefix=String(process.env.N8N_PATH||"/").replace(/^\/+|\/+$/g,"");
  const roots=[...new Set(["/api/v1",...(prefix?["/"+prefix+"/api/v1"]:[])])];
  let selected=null;
  return async function api(method,path,payload){
    for(const root of selected?[selected]:roots){
      let response;
      try{response=await fetch(base+root+path,{method,
        headers:{"X-N8N-API-KEY":key,"Accept":"application/json",
          ...(payload?{"Content-Type":"application/json"}:{})},
        ...(payload?{body:JSON.stringify(payload)}:{}),
        signal:AbortSignal.timeout(15000),
      });}catch{fail("API_UNAVAILABLE","n8n API unavailable");}
      if(response.status===404 && !selected && root!==roots.at(-1) && method==="GET")continue;
      if(!response.ok)fail(response.status===403?"API_FORBIDDEN":
        response.status===401?"API_UNAUTHORIZED":"API_ERROR",
        "n8n registry setup rejected, HTTP "+response.status);
      selected=root;
      try{return await response.json();}catch{fail("INVALID_RESPONSE","Invalid n8n API JSON");}
    }
    fail("API_UNAVAILABLE","n8n API prefix unavailable");
  };
}
async function list(api,path){
  const items=[];let cursor=null;
  for(let i=0;i<50;i++){
    const response=await api("GET",path+"?limit=250"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
    const rows=Array.isArray(response)?response:response?.data;
    if(!Array.isArray(rows))fail("INVALID_RESPONSE","Invalid n8n list result");
    items.push(...rows);cursor=response?.nextCursor??null;
    if(!cursor)return items;
  }
  fail("PAGINATION","n8n list exceeds bound");
}
async function main(){
  if(process.env.APP_ENV!=="development")fail("DISABLED","Contract registry mock is development-only");
  const req=await input();
  if(!req||!["inspect","prepare","verify"].includes(req.action)||typeof req.apiKey!=="string"||
    req.apiKey.length<16)fail("INVALID_INPUT","Invalid request");
  const api=apiClient(req.apiKey);
  const [tables,workflows]=await Promise.all([list(api,"/data-tables"),list(api,"/workflows")]);
  const matching=tables.filter(t=>t.name===TABLE);
  if(matching.length>1)fail("TABLE_CONFLICT","Duplicate contract registry tables");
  let table=matching[0]??null;
  if(table){
    if(!Array.isArray(table.columns))table=await api("GET","/data-tables/"+table.id);
    const existing=new Map((table.columns||[]).map(c=>[c.name,c.type]));
    if(columns.some(c=>existing.get(c.name)!==c.type))
      fail("TABLE_SCHEMA_MISMATCH","Existing registry schema must be reconciled manually");
  }
  const matchingWf=workflows.filter(w=>w.name===WORKFLOW);
  if(matchingWf.length>1)fail("WORKFLOW_CONFLICT","Duplicate contract registry workflows");
  if(req.action==="prepare"&&!table){
    table=await api("POST","/data-tables",{name:TABLE,columns});
    if(!table?.id)fail("UNCERTAIN_CREATE","Table creation uncertain; inspect before retry");
  }
  return {ok:true,table:TABLE,tableExists:Boolean(table),
    workflowInstalled:matchingWf.length===1,
    workflowActive:matchingWf[0]?.active===true,
    complete:Boolean(table)&&matchingWf.length===1};
}
try{process.stdout.write(JSON.stringify(await main())+"\n");}
catch(e){process.stdout.write(JSON.stringify({ok:false,code:e.code??"SETUP_FAILED",
  error:String(e.message).slice(0,220)})+"\n");}
