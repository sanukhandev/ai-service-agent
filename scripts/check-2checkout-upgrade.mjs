#!/usr/bin/env node
/** Offline Windows/Linux regression suite for guarded n8n payment upgrades. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./upgrade-n8n-2checkout.mjs";

for (const option of ["--inspect", "--backup", "--apply", "--dry-run"]) {
  assert.equal(parseArgs([option]), option);
}
assert.throws(() => parseArgs([]));
assert.throws(() => parseArgs(["--apply", "--backup"]));
const dry=spawnSync(process.execPath,["scripts/upgrade-n8n-2checkout.mjs","--dry-run"],{
  encoding:"utf8",
});
assert.equal(dry.status,0,dry.stderr);

const dir=mkdtempSync(join(tmpdir(),"n8n-2checkout-upgrade-"));
try {
  const file=join(dir,"mock.mjs");
  const mock=[
    'import {readFileSync} from "node:fs";',
    'const source=[',
    ' JSON.parse(readFileSync("infra/n8n/ancfz/02-render-pdf.json","utf8")),',
    ' JSON.parse(readFileSync("infra/n8n/ancfz/03-mockgateway-payment-link.json","utf8")),',
    ' JSON.parse(readFileSync("infra/n8n/ancfz/04-mockgateway-payment-verify.json","utf8")),',
    '];',
    'const oldNames=["ANCFZ | PDF Quotation or Invoice","ANCFZ | MockGateway Demo Order Request (checkout URL if provided)","ANCFZ | MockGateway Demo Orders Status (Fail Closed Until Verified)"];',
    'const oldNodes=["Prepare Escaped HTML","MockGateway Demo Orders POST","Reject Unverified Demo Order"];',
    'const paths=["ancfz/render-pdf","ancfz/payment-link","ancfz/payment-verify"];',
    'const hookCred={httpHeaderAuth:{id:"feb4e5dc-ae64-4ca8-bf87-dd1fae009fa1",name:"ANCFZ - Node to n8n Webhook Header"}};',
    'const payCred={httpHeaderAuth:{id:"4d9487aa-e07b-4bfd-92b9-a9699ffb5e45",name:"ANCFZ - MockGateway Demo X-API-Key"}};',
    'const mode=process.env.MOCK_UPGRADE||"legacy";',
    'let rows=source.map((d,i)=>{',
    ' const legacy=mode!=="updated"&&mode!=="drift";',
    ' const web=structuredClone(d.nodes.find(n=>n.type==="n8n-nodes-base.webhook"));',
    ' web.credentials=hookCred;',
    ' const old={name:oldNodes[i],type:i===1?"n8n-nodes-base.httpRequest":"n8n-nodes-base.code",',
    '   credentials:i===1?payCred:undefined,parameters:i===1?{method:"POST"}:{jsCode:"return []"}};',
    ' const priorInvoice=structuredClone(d);',
    ' if(i===0)priorInvoice.nodes.find(n=>n.name==="Prepare Escaped HTML").parameters.jsCode="if(b.documentType===\\'invoice\\' && b.paymentVerified!==true) throw new Error(\\'Invoice requires verified test payment\\');";',
    ' const content=legacy?(i===0?priorInvoice:{name:oldNames[i],nodes:[web,old],',
    '   connections:{},settings:d.settings}):{...d};',
    ' return {...content,id:"wf-"+i,active:mode==="active"&&i===0};',
    '});',
    'if(mode==="drift")rows[1].nodes.find(n=>n.name==="Inspect Demo Order Response").parameters.jsCode+="\\n// drift";',
    'if(mode==="credential")rows[1].nodes.find(n=>n.name===oldNodes[1]).credentials.httpHeaderAuth.id="wrong-id";',
    'globalThis.fetch=async (url,opts={})=>{',
    ' const u=new URL(url);const method=opts.method||"GET";',
    ' if(u.pathname.endsWith("/workflows")&&method==="GET")',
    '   return Response.json({data:rows.map(w=>({id:w.id,name:w.name,active:w.active}))});',
    ' const id=u.pathname.split("/").pop();const row=rows.find(w=>w.id===id);',
    ' if(!row)throw Error("Unexpected n8n path "+u.pathname);',
    ' if(method==="PUT"){const body=JSON.parse(opts.body);Object.assign(row,body);',
    '   return Response.json({id:row.id,name:row.name,active:row.active});}',
    ' return Response.json(row);',
    '};',
  ].join("\n");
  writeFileSync(file,mock,{mode:0o600});
  function simulate(action, fixture, extra = {}, env={}) {
    const p=spawnSync(process.execPath,[
      "--import",pathToFileURL(file).href,"infra/n8n/ancfz/upgrade-2checkout.mjs",
    ], {
      input:JSON.stringify({action,apiKey:"x".repeat(40),...extra}),
      encoding:"utf8",env:{...process.env,APP_ENV:"development",MOCK_UPGRADE:fixture,...env},
    });
    assert.equal(p.status,0,p.stderr);
    return JSON.parse(p.stdout.trim());
  }
  const inspected=simulate("inspect","legacy");
  assert.equal(inspected.ok,true);
  assert(inspected.workflows.every(w=>w.state==="legacy_needs_upgrade"));
  const backup=simulate("snapshot","legacy");
  assert.equal(backup.ok,true);
  assert.equal(backup.snapshot.length,3);
  assert(backup.snapshot.every(x=>x.document.id===x.id && /^[a-f0-9]{64}$/.test(x.hash)));
  assert.equal(simulate("apply","legacy").code,"BACKUP_REQUIRED");
  const expected=backup.snapshot.map(({id,hash})=>({id,hash}));
  assert.equal(simulate("apply","legacy",{expected}).applied,true);
  assert.equal(simulate("apply","legacy",{expected:[{id:"wf-0",hash:"a".repeat(64)},expected[1]]}).code,"SNAPSHOT_CHANGED");
  assert(simulate("inspect","updated").workflows.every(w=>w.state==="already_upgraded"));
  assert.equal(simulate("inspect","drift").code,"SOURCE_DRIFT");
  assert.equal(simulate("inspect","active").code,"WORKFLOW_ACTIVE");
  assert.equal(simulate("inspect","credential").code,"CREDENTIAL_CONFLICT");
  assert.equal(simulate("apply","legacy",{expected},{APP_ENV:"production"}).code,"DISABLED");
} finally {
  rmSync(dir,{recursive:true,force:true});
}
console.log("2Checkout n8n upgrade PASS: read-only inspect, snapshot, guarded update, credential/drift checks, active refusal, production disabled");
