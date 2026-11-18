#!/usr/bin/env node
/** Internal Docker-only local agreement Data Table and workflow preflight.
 * Key is supplied through stdin and never logged. No credential/owner reset. */
const NAME="ANCFZ_POC_AGREEMENTS";
const FLOW="ANCFZ | Agreement Register Data Table (LOCAL ONLY)";
const COLUMNS=[
  {name:"agreementNumber",type:"string"},
  {name:"revision",type:"number"},
  {name:"ticketId",type:"string"},
  {name:"quotationNumber",type:"string"},
  {name:"invoiceNumber",type:"string"},
  {name:"status",type:"string"},
  {name:"recordedAt",type:"date"},
];
class Preflight extends Error{
  constructor(code,message){super(message);this.code=code;}
}
const fail=(code,message)=>{throw new Preflight(code,message);};
async function input(){
  let body="";
  for await (const chunk of process.stdin){
    body+=chunk.toString("utf8");
    if(body.length>8192)fail("INVALID_INPUT","Input exceeds 8 KiB");
  }
  try{return JSON.parse(body);}catch{fail("INVALID_INPUT","Invalid JSON");}
}
function apiClient(apiKey){
  const base="http://127.0.0.1:5678";
  const prefix=String(process.env.N8N_PATH||"/").replace(/^\/+|\/+$/g,"");
  const roots=[...new Set(["/api/v1",...(prefix?["/"+prefix+"/api/v1"]:[])])];
  let root=null;
  return async(method,path,payload)=>{
    for(const candidate of root?[root]:roots){
      let response;
      try{
        response=await fetch(new URL(candidate+path,base),{
          method,
          headers:{"X-N8N-API-KEY":apiKey,"Accept":"application/json",
            ...(payload?{"Content-Type":"application/json"}:{})},
          ...(payload?{body:JSON.stringify(payload)}:{}),
          signal:AbortSignal.timeout(15000),
        });
      }catch{fail("API_UNAVAILABLE","Private n8n API unavailable");}
      if(response.status===404&&method==="GET"&&!root&&candidate!==roots.at(-1))continue;
      if(response.status===401)fail("API_UNAUTHORIZED","Owner API key invalid");
      if(response.status===403)fail("API_FORBIDDEN","Owner API key lacks permission");
      if(!response.ok)fail("API_ERROR","n8n "+method+" "+path.split("?")[0]+" HTTP "+response.status);
      root=candidate;
      try{return await response.json();}catch{fail("INVALID_RESPONSE","Invalid n8n JSON");}
    }
    fail("API_UNAVAILABLE","n8n private API prefix unavailable");
  };
}
async function list(api,path){
  let cursor=null;const out=[];const seen=new Set();
  for(let i=0;i<50;i++){
    const page=await api("GET",path+"?limit=250"+(cursor?"&cursor="+encodeURIComponent(cursor):""));
    const rows=Array.isArray(page)?page:page?.data;
    if(!Array.isArray(rows))fail("INVALID_RESPONSE","Unexpected n8n API list");
    out.push(...rows);cursor=page?.nextCursor||null;
    if(!cursor)return out;
    if(typeof cursor!=="string"||seen.has(cursor))fail("INVALID_RESPONSE","Invalid API cursor");
    seen.add(cursor);
  }
  fail("INVALID_RESPONSE","Pagination limit exceeded");
}
try{
  if(process.env.APP_ENV!=="development")fail("DISABLED","Local agreements require APP_ENV=development");
  const v=await input();
  if(!["inspect","prepare","verify"].includes(v?.action)||
     typeof v?.apiKey!=="string"||v.apiKey.trim().length<16)
    fail("INVALID_INPUT","Expected private owner key and allowed action");
  const api=apiClient(v.apiKey.trim());
  const [tables,workflows]=await Promise.all([list(api,"/data-tables"),list(api,"/workflows")]);
  const t=tables.filter(x=>x.name===NAME);
  const w=workflows.filter(x=>x.name===FLOW);
  if(t.length>1||w.length>1)fail("CONFLICT","Duplicate agreement table or workflow");
  if(w[0]&&v.action==="prepare"&&w[0].active)
    fail("ALREADY_ACTIVE","Agreement workflow is active; review it in n8n");
  let table=t[0]||null;
  if(table&&!Array.isArray(table.columns))
    table=await api("GET","/data-tables/"+encodeURIComponent(table.id));
  if(table){
    const existing=new Map((table.columns||[]).map(x=>[x.name,x.type]));
    if(COLUMNS.some(x=>existing.get(x.name)!==x.type))
      fail("SCHEMA_CONFLICT","Existing agreement table differs; no records modified");
  }
  if(v.action==="prepare"&&!table){
    table=await api("POST","/data-tables",{name:NAME,columns:COLUMNS});
    if(table?.name!==NAME||!table?.id)fail("CREATE_UNCERTAIN","Inspect n8n before retry");
  }
  const result={ok:true,table:NAME,tableExists:Boolean(table),
    workflowInstalled:w.length===1,workflowActive:w[0]?.active===true,
    ...(v.action==="verify"?{complete:Boolean(table)&&w.length===1}:{})};
  process.stdout.write(JSON.stringify(result)+"\n");
}catch(error){
  process.stdout.write(JSON.stringify({ok:false,
    code:error?.code||"SETUP_FAILED",error:String(error?.message||"Setup failed")})+"\n");
}
