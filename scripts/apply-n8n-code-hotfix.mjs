#!/usr/bin/env node
/** Host-side guarded workflow patch: requires EXISTING n8n owner key; no provider calls. */
import {spawnSync} from "node:child_process";
import {chmodSync,mkdirSync,mkdtempSync,writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {fileURLToPath} from "node:url";
import {join,resolve} from "node:path";

const cwd=resolve(fileURLToPath(new URL("../",import.meta.url)));
const safeId=/^[A-Za-z0-9_-]{1,150}$/;
export function parseArgs(args){
  if(args.length!==1||!["--inspect","--backup","--apply","--dry-run"].includes(args[0]))
    throw Error("Use exactly one of --inspect, --backup, --apply, --dry-run");
  return args[0];
}
function docker(args,input){
  const x=spawnSync("docker",["compose","--profile","workflows",...args],{
    cwd,input,encoding:"utf8",stdio:["pipe","pipe","pipe"],
    timeout:90000,maxBuffer:8*1024*1024,
  });
  if(x.error||x.status!==0)
    throw Error("Private n8n operation failed; inspect container state and key locally");
  return x.stdout.trim();
}
function helper(action,key,expected){
  const raw=docker(["exec","-T","n8n","node","/workflows/ancfz/upgrade-code-hotfix.mjs"],
    JSON.stringify({action,apiKey:key,...(expected?{expected}:{})}));
  let r;try{r=JSON.parse(raw)}catch{throw Error("Unreadable private upgrader output")}
  if(r?.ok!==true)
    throw Error((r?.code||"HOTFIX_FAILED")+": "+String(r?.error||"Unknown").slice(0,180));
  return r;
}
function saveBackups(snapshot){
  if(!Array.isArray(snapshot)||snapshot.length!==3)
    throw Error("Expected precisely three workflow backup records");
  const base=join(homedir(),"ai-service-agent-n8n-backups");
  mkdirSync(base,{recursive:true,mode:0o700});
  const directory=mkdtempSync(join(base,"salesforce-checkout-"));
  chmodSync(directory,0o700);
  const manifest=[];
  for(const x of snapshot){
    if(!safeId.test(x.id)||!/^[a-f0-9]{64}$/.test(x.hash)||x.document?.id!==x.id)
      throw Error("Invalid workflow snapshot; no changes applied");
    writeFileSync(join(directory,x.id+".json"),JSON.stringify(x.document,null,2)+"\n",{
      mode:0o600,flag:"wx",
    });
    manifest.push({id:x.id,path:x.path,hash:x.hash});
  }
  writeFileSync(join(directory,"manifest.json"),JSON.stringify(manifest,null,2)+"\n",{
    mode:0o600,flag:"wx",
  });
  return {directory,expected:manifest.map(({id,hash})=>({id,hash}))};
}
export function main(args=process.argv.slice(2)){
  const action=parseArgs(args);
  if(action==="--dry-run"){
    console.log("Salesforce/checkout hotfix dry-run PASS: existing workflows only, no credentials, provider calls, or n8n changes");
    return;
  }
  const key=process.env.N8N_API_KEY;
  if(typeof key!=="string"||key.trim().length<16)
    throw Error("Supply existing owner N8N_API_KEY privately");
  docker(["config","--quiet"]);
  if(!docker(["ps","--status","running","-q","n8n"]))
    throw Error("Existing n8n container not running");
  if(action==="--inspect"){
    console.log(JSON.stringify(helper("inspect",key.trim())));
    return;
  }
  const snapshot=helper("snapshot",key.trim()).snapshot;
  const backup=saveBackups(snapshot);
  console.log("Private workflow backup: "+backup.directory);
  if(action==="--backup")return;
  const applied=helper("apply",key.trim(),backup.expected);
  if(!applied.applied)throw Error("No update confirmation from n8n");
  console.log(JSON.stringify(applied));
  console.log("Workflows remain unpublished. Verify Salesforce OAuth and merchant credentials independently, then publish after safety review.");
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main()}catch(e){console.error("n8n hotfix halted: "+String(e.message||"Unknown"));process.exitCode=1}
}
