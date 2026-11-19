#!/usr/bin/env node
/** Inspects the EXISTING n8n owner workspace; no data or credentials mutated. */
const NAME="ANCFZ | TEST Licence to Contract Lookup (LOCAL ONLY)";
const TABLE="ANCFZ_POC_CONTRACTS";
let raw="";
for await(const part of process.stdin){raw+=String(part);if(raw.length>8192)throw Error("Oversized input");}
try{
  const {apiKey}=JSON.parse(raw);
  if(typeof apiKey!=="string"||apiKey.length<16)throw Error("Invalid owner key");
  const base="http://127.0.0.1:5678";
  const roots=["/api/v1","/n8n/api/v1"];
  let prefix=null;
  async function list(resource){
    for(const root of prefix?[prefix]:roots){
      const out=[];let cursor=null;
      for(let attempt=0;attempt<50;attempt++){
        const query=root+"/"+resource+"?limit=250"+(cursor?"&cursor="+encodeURIComponent(cursor):"");
        const resp=await fetch(base+query,{headers:{"X-N8N-API-KEY":apiKey},signal:AbortSignal.timeout(12000)});
        if(resp.status===404 && !prefix && root!==roots.at(-1))break;
        if(!resp.ok)throw Error("n8n owner API unavailable HTTP "+resp.status);
        prefix=root;
        const json=await resp.json();const rows=Array.isArray(json)?json:json?.data;
        if(!Array.isArray(rows))throw Error("Unexpected owner API response");
        out.push(...rows);cursor=json?.nextCursor??null;
        if(!cursor)return out;
      }
    }
    throw Error("Unable to read n8n owner API list");
  }
  const [tables,workflows]=await Promise.all([list("data-tables"),list("workflows")]);
  const target=workflows.filter(x=>x.name===NAME);
  const table=tables.filter(x=>x.name===TABLE);
  if(target.length>1||table.length!==1)throw Error("Duplicate workflow or missing/duplicate contract registry table");
  process.stdout.write(JSON.stringify({ok:true,tableExists:true,
    workflowInstalled:target.length===1,workflowActive:target[0]?.active===true})+"\n");
}catch(error){
  process.stdout.write(JSON.stringify({ok:false,error:String(error.message).slice(0,180)})+"\n");
}
