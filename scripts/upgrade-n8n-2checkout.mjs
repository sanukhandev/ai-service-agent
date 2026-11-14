#!/usr/bin/env node
/**
 * Safe workflow upgrade on an existing owner installation, not a reseed.
 * n8n API key is passed through Docker stdin only; no secret printing.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateExistingConfig } from "./seed-n8n-anzfc.mjs";

const cwd=resolve(fileURLToPath(new URL("../",import.meta.url)));
function docker(args,input){
  const result=spawnSync("docker",["compose","--profile","workflows",...args],{
    cwd,input,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:90000,
  });
  if(result.error||result.status!==0)
    throw Error("Private Docker operation failed; inspect the local container without sharing credentials");
  return result.stdout.trim();
}
export function parseArgs(args){
  if(args.length!==1||!["--inspect","--apply","--dry-run"].includes(args[0]))
    throw Error("Use exactly one of --inspect, --apply or --dry-run");
  return args[0];
}
export function main(args=process.argv.slice(2)){
  const action=parseArgs(args);
  if(action==="--dry-run"){
    console.log("2Checkout mock upgrade dry run: two existing inactive payment workflows; no Docker/provider/credential changes");
    return;
  }
  const key=process.env.N8N_API_KEY;
  if(typeof key!=="string"||key.trim().length<16)
    throw Error("Enter the existing owner API key privately as N8N_API_KEY");
  const config=validateExistingConfig(docker(["config","--format","json"]));
  if(config.services?.n8n?.environment?.APP_ENV!=="development")
    throw Error("The workflow upgrade is development-only");
  if(!docker(["ps","--status","running","-q","n8n"]))
    throw Error("Existing n8n container must be running");
  const result=docker(["exec","-T","n8n","node","/workflows/ancfz/upgrade-2checkout.mjs"],
    JSON.stringify({action:action==="--apply"?"apply":"inspect",apiKey:key.trim()}));
  let parsed;
  try{parsed=JSON.parse(result);}
  catch{throw Error("Private workflow upgrader returned invalid response");}
  if(parsed?.ok!==true)
    throw Error((parsed?.code||"UPGRADE_FAILED")+": "+(parsed?.error||"Workflow upgrade failed"));
  console.log(JSON.stringify(parsed));
  if(action==="--apply")
    console.log("Payment workflows updated inactive; configure rotated X-Avangate-Authentication credential privately before activation.");
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main();}
  catch(error){console.error("2Checkout upgrade stopped: "+error.message);process.exitCode=1;}
}
