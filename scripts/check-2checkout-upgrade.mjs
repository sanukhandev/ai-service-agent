#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./upgrade-n8n-2checkout.mjs";
assert.equal(parseArgs(["--inspect"]),"--inspect");
assert.equal(parseArgs(["--apply"]),"--apply");
assert.throws(()=>parseArgs([]));
const offline=spawnSync(process.execPath,["scripts/upgrade-n8n-2checkout.mjs","--dry-run"],{encoding:"utf8"});
assert.equal(offline.status,0,offline.stderr);
const dir=mkdtempSync(join(tmpdir(),"2co-n8n-"));
try{
  const file=join(dir,"mock.mjs");
  const mock=[
    'const old=[',
    ' {id:"wf-create",name:"ANCFZ | MockGateway Demo Order Request (checkout URL if provided)",active:false,path:"ancfz/payment-link",oldNode:"MockGateway Demo Orders POST"},',
    ' {id:"wf-verify",name:"ANCFZ | MockGateway Demo Orders Status (Fail Closed Until Verified)",active:false,path:"ancfz/payment-verify",oldNode:"Reject Unverified Demo Order"},',
    '];',
    'const fresh=["ANCFZ | 2Checkout Mock Order Create","ANCFZ | 2Checkout Mock Payment Verification"];',
    'const mode=process.env.MOCK_UPGRADE||"legacy";',
    'const workflows=old.map((w,i)=>({...w,name:mode==="updated"?fresh[i]:w.name,oldNode:mode==="updated"?(i?"2Checkout Mock GET Order":"2Checkout Mock Orders POST"):w.oldNode,active:mode==="active"&&i===0}));',
    'globalThis.fetch=async(url,opts={})=>{',
    ' const u=new URL(url);',
    ' if(u.pathname.endsWith("/workflows") && opts.method==="GET") return Response.json({data:workflows.map(w=>({id:w.id,name:w.name,active:w.active}))});',
    ' const id=u.pathname.split("/").pop();const w=workflows.find(x=>x.id===id);',
    ' if(!w) throw Error("Unknown GET/PUT path");',
    ' if(opts.method==="PUT"){ const body=JSON.parse(opts.body); w.name=body.name;w.nodes=body.nodes;return Response.json({id:w.id,name:w.name,active:false}); }',
    ' return Response.json({id:w.id,name:w.name,active:w.active,nodes:w.nodes||[',
    ' {type:"n8n-nodes-base.webhook",name:"Receive",parameters:{path:w.path,authentication:"headerAuth"}},',
    ' {type:"n8n-nodes-base.code",name:w.oldNode,parameters:{jsCode:"return []"}}',
    ' ]});',
    '};'
  ].join("\n");
  writeFileSync(file,mock,{mode:0o600});
  function run(action,mode,extra={}){
    const p=spawnSync(process.execPath,
      ["--import",pathToFileURL(file).href,"infra/n8n/ancfz/upgrade-2checkout.mjs"],{
        input:JSON.stringify({action,apiKey:"x".repeat(40)}),encoding:"utf8",
        env:{...process.env,APP_ENV:"development",MOCK_UPGRADE:mode,...extra},
      });
    assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout.trim());
  }
  const inspection=run("inspect","legacy");
  assert.equal(inspection.ok,true);
  assert(inspection.workflows.every(x=>x.state==="legacy_needs_upgrade"));
  assert.equal(run("apply","legacy").applied,true);
  assert(run("inspect","updated").workflows.every(x=>x.state==="already_upgraded"));
  assert.equal(run("inspect","active").code,"WORKFLOW_ACTIVE");
  assert.equal(run("apply","legacy",{APP_ENV:"production"}).code,"DISABLED");
}finally{rmSync(dir,{recursive:true,force:true});}
console.log("2Checkout n8n upgrade PASS: dry-run, inspect, guarded update, active refusal, production disabled");
