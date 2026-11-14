#!/usr/bin/env node
// Offline security/structure and mock n8n public-API validation; no Docker or secrets.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, validateWorkflowFiles } from "./setup-n8n-mock-otp.mjs";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const delivery = read("../infra/n8n/ancfz/05-mock-otp-table.json");
const cleanup = read("../infra/n8n/ancfz/06-mock-otp-prune.json");
validateWorkflowFiles();

assert.equal(parseArgs(["--inspect"]), "--inspect");
assert.equal(parseArgs(["--setup"]), "--setup");
assert.equal(parseArgs(["--dry-run"]), "--dry-run");
assert.throws(() => parseArgs([]));
assert.throws(() => parseArgs(["--setup", "--inspect"]));
const offline = spawnSync(process.execPath, ["scripts/setup-n8n-mock-otp.mjs", "--dry-run"], {
  cwd, encoding: "utf8",
});
assert.equal(offline.status, 0, offline.stderr);
assert.match(offline.stdout, /no changes made/i);
const noSecretEnv = {...process.env};
delete noSecretEnv.ANCFZ_N8N_WEBHOOK_SECRET;
const noSecretSmoke = spawnSync(process.execPath, ["scripts/test-n8n-mock-otp.mjs"], {
  cwd, env:noSecretEnv, encoding:"utf8",
});
assert.notEqual(noSecretSmoke.status,0,"Synthetic dispatch must require explicit secret");
assert.match(noSecretSmoke.stderr,/Set ANCFZ_N8N_WEBHOOK_SECRET privately/);

for (const wf of [delivery, cleanup]) {
  assert.equal(wf.active, false);
  assert.equal(wf.settings.saveDataSuccessExecution, "none");
  assert.equal(wf.settings.saveDataErrorExecution, "none");
  assert.equal(wf.settings.saveManualExecutions, false);
  assert.equal(wf.nodes.filter(n => n.type === "n8n-nodes-base.emailSend").length, 0);
  assert.equal(wf.nodes.filter(n => n.type === "n8n-nodes-base.dataTable").length, 1);
  const tableNode = wf.nodes.find(n => n.type === "n8n-nodes-base.dataTable");
  assert.equal(tableNode.parameters.dataTableId.mode, "name");
  assert.equal(tableNode.parameters.dataTableId.value, "ANCFZ_POC_OTPS");
}
const webhook = delivery.nodes.find(n => n.type === "n8n-nodes-base.webhook");
assert.equal(webhook.parameters.authentication, "headerAuth");
assert.equal(webhook.parameters.path, "ancfz/otp-email");
assert.equal(webhook.credentials.httpHeaderAuth.id, "feb4e5dc-ae64-4ca8-bf87-dd1fae009fa1");

const dataNode = delivery.nodes.find(n => n.type === "n8n-nodes-base.dataTable");
assert.equal(dataNode.parameters.operation, "insert");
assert.deepEqual(Object.keys(dataNode.parameters.columns.value).sort(),
  ["ticketId","emailMasked","otp","issuedAt","expiresAt","status"].sort());
const response = delivery.nodes.find(n => n.type === "n8n-nodes-base.respondToWebhook");
assert(!response.parameters.responseBody.includes(".json.otp"), "Never return OTP from webhook");
assert(response.parameters.responseBody.includes("mock_recorded"));

const gate = delivery.nodes.find(n => n.name === "Validate Mock OTP");
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const executeGate = new AsyncFunction("$input", "$env", gate.parameters.jsCode);
const input = {
  first: () => ({json:{body:{
    agentKey:"ancfz",ticketId:"11111111-1111-4111-8111-111111111111",
    email:"tester@example.invalid",otp:"002345",
  }}}),
};
const enabled = {APP_ENV:"development",ANCFZ_OTP_MOCK_ENABLED:"true"};
const start = Date.now();
const rows = await executeGate(input, enabled);
assert.equal(rows.length,1);
assert.equal(rows[0].json.otp,"002345");
assert.match(rows[0].json.emailMasked,/^te\*\*\*@example\.invalid$/);
assert.equal(rows[0].json.status,"mock_issued");
assert(Math.abs(new Date(rows[0].json.expiresAt).getTime() -
   new Date(rows[0].json.issuedAt).getTime() - 300000) < 100);
assert(new Date(rows[0].json.issuedAt).getTime() >= start - 1000);
await assert.rejects(executeGate(input, {...enabled,APP_ENV:"production"}),/disabled/i);
await assert.rejects(executeGate(input, {...enabled,APP_ENV:"staging"}),/disabled/i);
await assert.rejects(executeGate(input, {...enabled,ANCFZ_OTP_MOCK_ENABLED:"false"}),/disabled/i);
await assert.rejects(executeGate({first:()=>({json:{body:{...input.first().json.body,otp:"bad"}}})},enabled),/Invalid test OTP/);

const schedule = cleanup.nodes.find(n => n.type === "n8n-nodes-base.scheduleTrigger");
assert.equal(schedule.parameters.rule.interval[0].minutesInterval,1);
const deleteNode = cleanup.nodes.find(n => n.type === "n8n-nodes-base.dataTable");
assert.equal(deleteNode.parameters.operation,"deleteRows");
assert.deepEqual(deleteNode.parameters.filters.conditions.map(c=>[c.keyName,c.condition]),[["expiresAt","lte"]]);
assert(cleanup.nodes.some(n=>n.parameters?.jsCode?.includes("ANCFZ_OTP_MOCK_ENABLED")));

const dir = mkdtempSync(join(tmpdir(), "n8n-mock-otp-"));
try {
  const preload = join(dir, "fake-n8n.mjs");
  const mock = [
    'const cols = ["ticketId","emailMasked","otp","issuedAt","expiresAt","status"].map(n => ({name:n,type:["issuedAt","expiresAt"].includes(n) ? "date" : "string"}));',
    'const table = {id:"dt-mock", name:"ANCFZ_POC_OTPS", columns:cols};',
    'const wfNames = ["ANCFZ | MOCK OTP Data Table Delivery (LOCAL ONLY)","ANCFZ | MOCK OTP Expiry Cleanup (LOCAL ONLY)"];',
    'globalThis.fetch = async (url, options={}) => {',
    '  const path = new URL(url).pathname;',
    '  const mode = process.env.MOCK_OTP_FIXTURE || "empty";',
    '  if (mode === "forbidden") return new Response("",{status:403});',
    '  if (mode === "smtp-active" && path.endsWith("/workflows")) return Response.json({data:[{name:"ANCFZ | Deliver Payment OTP (Node Generated)",active:true}]});',
    '  if (path.endsWith("/data-tables") && options.method === "POST") return Response.json(table,{status:201});',
    '  if (path.endsWith("/data-tables")) return Response.json({data:mode==="ready" || mode==="schema-mismatch" ? [mode==="schema-mismatch" ? {...table, columns:[{name:"ticketId",type:"number"}]} : table] : []});',
    '  if (path.endsWith("/workflows")) return Response.json({data:mode==="ready" ? wfNames.map(name=>({name,active:false})) : []});',
    '  throw Error("Unexpected mock API request: " + path);',
    '};',
  ].join("\n");
  writeFileSync(preload,mock);
  const inputArgs = {apiKey:"x".repeat(40)};
  function simulate(action,fixture) {
    const p = spawnSync(process.execPath,
      ["--import",pathToFileURL(preload).href,"infra/n8n/ancfz/setup-mock-otp.mjs"],{
        cwd, env:{...process.env,APP_ENV:"development",MOCK_OTP_FIXTURE:fixture},
        input:JSON.stringify({...inputArgs,action}),encoding:"utf8",
      });
    assert.equal(p.status,0,p.stderr);
    return JSON.parse(p.stdout);
  }
  assert.equal(simulate("inspect","empty").tableExists,false);
  const prepared = simulate("prepare","empty");
  assert.equal(prepared.ok,true);
  assert.equal(prepared.tableExists,true);
  assert.equal(prepared.missingWorkflows.length,2);
  assert.equal(simulate("verify","ready").complete,true);
  assert.equal(simulate("inspect","schema-mismatch").code,"TABLE_SCHEMA_MISMATCH");
  assert.equal(simulate("inspect","smtp-active").code,"SMTP_WORKFLOW_ACTIVE");
  assert.equal(simulate("inspect","forbidden").code,"API_FORBIDDEN");
} finally {
  rmSync(dir,{recursive:true,force:true});
}
console.log("ANCFZ mock OTP: Data Table, 5-minute TTL, safety gates, 1-minute purge, private webhook and installer mock API PASS");
