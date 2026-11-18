#!/usr/bin/env node
/** Opt-in registry setup for an existing local n8n owner workspace. */
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {validateExistingConfig} from "./seed-n8n-anzfc.mjs";
const cwd=resolve(fileURLToPath(new URL("../",import.meta.url)));
function exec(args,input){
  const p=spawnSync("docker",["compose","--profile","workflows",...args],{
    cwd,input,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:90000,maxBuffer:1024*1024,
  });
  if(p.error||p.status!==0)throw Error("Docker n8n command failed; inspect privately");
  return p.stdout.trim();
}
function inspect(action,key){
  const raw=exec(["exec","-T","n8n","node","/workflows/ancfz/setup-contract-registry.mjs"],
    JSON.stringify({action,apiKey:key}));
  let body;try{body=JSON.parse(raw);}catch{throw Error("Invalid registry setup result");}
  if(body.ok!==true)throw Error((body.code??"ERROR")+": "+(body.error??"Registry setup failed"));
  return body;
}
function main(){
  const mode=process.argv[2];
  if(process.argv.length!==3||!["--dry-run","--inspect","--setup"].includes(mode))
    throw Error("Use --dry-run, --inspect or --setup");
  if(mode==="--dry-run"){
    console.log("Contract registry: ANCFZ_POC_CONTRACTS; 1 inactive webhook workflow; no changes");
    return;
  }
  const key=process.env.N8N_API_KEY;
  if(!key||key.trim().length<16)throw Error("Supply existing n8n owner N8N_API_KEY privately");
  const config=validateExistingConfig(exec(["config","--format","json"]));
  if(config.services?.n8n?.environment?.APP_ENV!=="development")
    throw Error("Contract registry mock requires APP_ENV=development");
  if(!exec(["ps","--status","running","-q","n8n"]))
    throw Error("Start existing n8n before registry installation");
  const before=inspect(mode==="--setup"?"prepare":"inspect",key.trim());
  if(mode==="--inspect"){console.log(JSON.stringify(before));return;}
  if(!before.workflowInstalled){
    exec(["exec","-T","n8n","n8n","import:workflow",
      "--input=/workflows/ancfz/07-mock-contract-registry.json",
      "--activeState=false"]);
  }
  const after=inspect("verify",key.trim());
  if(!after.complete)throw Error("Contract registry incomplete; inspect before retry");
  console.log("Contract registry table created/verified; workflow installed inactive. "+
    "Activate the workflow after checking its header-auth credential.");
}
try{main();}catch(e){console.error(String(e.message??e));process.exitCode=1;}
