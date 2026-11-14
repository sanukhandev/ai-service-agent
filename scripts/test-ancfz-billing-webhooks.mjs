#!/usr/bin/env node
// Operator-only local billing smoke; deliberately never creates a payment order or invoice.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const cwd=resolve(fileURLToPath(new URL("../",import.meta.url)));
const arg=process.argv[2];
const action=arg==="--quotation"?"quotation":null;
const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
if(!action) {
  console.error("Usage: node scripts/test-ancfz-billing-webhooks.mjs --quotation (2Checkout status requires a genuine order reference)");
  process.exitCode=1;
} else if(typeof secret!=="string"||secret.length<32) {
  console.error("Set private ANCFZ_N8N_WEBHOOK_SECRET to match the n8n Header Auth credential");
  process.exitCode=1;
} else {
  const p=spawnSync("docker",["compose","--profile","workflows","exec","-T",
    "n8n","node","/workflows/ancfz/test-billing-webhooks.mjs"],{
      cwd,input:JSON.stringify({action,secret}),encoding:"utf8",
      stdio:["pipe","pipe","pipe"],timeout:45000,maxBuffer:1024*1024,
    });
  if(p.error||p.status!==0) {
    // Never print Docker stdout/stderr; they may include the secret or payload.
    console.error("Private n8n "+action+" smoke failed. Confirm workflow is active and Header Auth matches.");
    process.exitCode=1;
  } else {
    try{
      const result=JSON.parse(p.stdout.trim());
      if(result.ok!==true)throw Error();
      if(action==="verification" && result.verified!==false)throw Error();
      if(action==="quotation" && (result.status!=="generated"||!Number.isInteger(result.pdfBytes)))throw Error();
      console.log(JSON.stringify(result));
    }catch{
      console.error("n8n smoke returned an unexpected response. Check the n8n workflow privately.");
      process.exitCode=1;
    }
  }
}
