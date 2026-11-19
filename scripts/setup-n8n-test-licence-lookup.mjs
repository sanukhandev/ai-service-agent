#!/usr/bin/env node
/** Explicit owner-only installer. Preserves existing n8n volume and credentials. */
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {validateExistingConfig} from "./seed-n8n-anzfc.mjs";
const cwd=resolve(fileURLToPath(new URL("../",import.meta.url)));
const mode=process.argv[2];
if(process.argv.length!==3||!["--dry-run","--inspect","--setup"].includes(mode)){
  console.error("Use --dry-run, --inspect or --setup");process.exit(2);
}
function run(args,input){
  const res=spawnSync("docker",["compose","--profile","workflows",...args],{
    cwd,input,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:90000,maxBuffer:1024*1024,
  });
  if(res.error||res.status!==0)throw Error("n8n Docker operation failed; inspect locally");
  return res.stdout.trim();
}
function inspect(key){
  const result=run(["exec","-T","n8n","node",
    "/workflows/ancfz/inspect-contract-licence-lookup.mjs"],JSON.stringify({apiKey:key}));
  const parsed=JSON.parse(result);
  if(parsed.ok!==true)throw Error(parsed.error||"Failed to inspect lookup workflow");
  return parsed;
}
try{
  if(mode==="--dry-run"){console.log("Read-only n8n TEST licence lookup; no changes");}
  else {
    const key=process.env.N8N_API_KEY;
    if(typeof key!=="string"||key.trim().length<16)throw Error("Supply existing owner N8N_API_KEY privately");
    const compose=validateExistingConfig(run(["config","--format","json"]));
    if(compose.services?.n8n?.environment?.APP_ENV!=="development")
      throw Error("TEST lookup setup is development-only");
    if(!run(["ps","--status","running","-q","n8n"]))throw Error("Existing n8n must be running");
    const before=inspect(key.trim());
    if(mode==="--setup"&&!before.workflowInstalled){
      run(["exec","-T","n8n","n8n","import:workflow",
        "--input=/workflows/ancfz/08-test-licence-contract-lookup.json",
        "--activeState=false"]);
    }
    const after=inspect(key.trim());
    console.log(JSON.stringify(after));
    if(mode==="--setup")console.log(
      "Review the existing private Header Auth credential and activate TEST lookup manually in n8n.");
  }
}catch(error){console.error(String(error.message??error));process.exitCode=1;}
