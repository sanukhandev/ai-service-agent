#!/usr/bin/env node
/** Install only the new agreement register Data Table and inactive n8n workflow.
 * Never reset an existing n8n owner, credentials, or volumes. */
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
const cwd=resolve(fileURLToPath(new URL("../",import.meta.url)));
const FLOW="ANCFZ | Agreement Register Data Table (LOCAL ONLY)";
function docker(args,input){
  const r=spawnSync("docker",["compose","--profile","workflows",...args],{
    cwd,input,encoding:"utf8",timeout:90000,maxBuffer:1024*1024,
    stdio:["pipe","pipe","pipe"],
  });
  if(r.status!==0||r.error)throw Error("Docker/n8n operation failed. Inspect n8n locally without revealing credentials");
  return r.stdout.trim();
}
function check(action,key){
  const raw=docker(["exec","-T","n8n","node","/workflows/ancfz/setup-agreements.mjs"],
    JSON.stringify({action,apiKey:key}));
  let parsed;
  try{parsed=JSON.parse(raw);}catch{throw Error("n8n preflight response is invalid");}
  if(parsed?.ok!==true)throw Error((parsed?.code||"SETUP_FAILED")+": "+(parsed?.error||"n8n preflight failed"));
  return parsed;
}
export function main(args=process.argv.slice(2)){
  if(args.length!==1||!["--dry-run","--inspect","--setup"].includes(args[0]))
    throw Error("Use --dry-run, --inspect, or --setup");
  if(args[0]==="--dry-run"){
    process.stdout.write("Review: create ANCFZ_POC_AGREEMENTS, import 07-agreement-register.json inactive. No changes.\n");
    return;
  }
  const key=process.env.N8N_API_KEY;
  if(typeof key!=="string"||key.trim().length<16)
    throw Error("Provide existing owner N8N_API_KEY privately in the local process environment");
  if(!docker(["ps","--status","running","-q","n8n"]))
    throw Error("Start the existing n8n service first");
  const first=check(args[0]==="--setup"?"prepare":"inspect",key.trim());
  if(args[0]==="--inspect"){
    process.stdout.write(JSON.stringify(first)+"\n");
    return;
  }
  if(!first.workflowInstalled){
    docker(["exec","-T","n8n","n8n","import:workflow",
      "--input=/workflows/ancfz/07-agreement-register.json","--activeState=false"]);
  }
  const result=check("verify",key.trim());
  if(!result.complete)throw Error("Agreement register not fully installed; inspect privately");
  process.stdout.write("Agreement Data Table and workflow installed. Activate only the agreement register workflow in n8n UI.\n");
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}catch(e){process.stderr.write("Agreement setup blocked: "+String(e.message)+"\n");process.exitCode=1;}
}
