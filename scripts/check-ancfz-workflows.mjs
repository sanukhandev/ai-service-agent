#!/usr/bin/env node
// Static contract check only. Running n8n and provider acceptance are separate gates.
import { readFileSync } from "node:fs";
const root = new URL("../infra/n8n/ancfz/", import.meta.url);
const expected = {
  "00-otp-email.json": "ancfz/otp-email",
  "01-salesforce-lead.json": "ancfz/salesforce-lead",
  "02-render-pdf.json": "ancfz/render-pdf",
  "03-mockgateway-payment-link.json": "ancfz/payment-link",
  "04-mockgateway-payment-verify.json": "ancfz/payment-verify",
};
const errors = [];
const allPaths = new Set();
for (const [filename, path] of Object.entries(expected)) {
  let workflow;
  try { workflow = JSON.parse(readFileSync(new URL(filename,root), "utf8")); }
  catch (error) {errors.push(filename+": invalid JSON "+error.message); continue;}
  if (workflow.active !== false) errors.push(filename+": must remain inactive until authenticated provider acceptance");
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length < 3) {errors.push(filename+": missing nodes");continue;}
  const names = new Set(workflow.nodes.map(node => node.name));
  for(const node of workflow.nodes){
    if(node.type==="n8n-nodes-base.code"){
      try { new Function("$input", "$", "Buffer", "URL", node.parameters?.jsCode ?? ""); }
      catch(e){ errors.push(filename+": invalid Code Node JS in "+node.name+": "+e.message); }
    }
  }
  if (names.size !== workflow.nodes.length) errors.push(filename+": duplicate node names");
  const webhooks = workflow.nodes.filter(node => node.type === "n8n-nodes-base.webhook");
  if (webhooks.length !== 1 || webhooks[0].parameters?.authentication !== "headerAuth" || webhooks[0].parameters?.responseMode !== "responseNode" || webhooks[0].parameters?.httpMethod !== "POST" || webhooks[0].parameters?.path !== path) {
    errors.push(filename+": missing private header-authenticated POST webhook");
  }
  if(allPaths.has(path)) errors.push(filename+": duplicate path");
  allPaths.add(path);
  if (!workflow.nodes.some(node => node.type === "n8n-nodes-base.respondToWebhook")) errors.push(filename+": missing response");
  if (workflow.nodes.some(node => node.credentials && JSON.stringify(node.credentials).match(/(api[_-]?key|password|token)/i))) errors.push(filename+": possible embedded credentials");
  if (workflow.settings?.saveDataSuccessExecution !== "none" || workflow.settings?.saveDataErrorExecution !== "none") errors.push(filename+": sensitive execution retention enabled");
  for (const [name, ports] of Object.entries(workflow.connections ?? {})) {
    if(!names.has(name)) errors.push(filename+": unknown upstream "+name);
    for(const line of ports.main ?? [])for(const connection of line)if(!names.has(connection.node))errors.push(filename+": unknown downstream "+connection.node);
  }
  const s=JSON.stringify(workflow);
  if (/https?:\/\/localhost:(5678|3000)/.test(s))errors.push(filename+": local browser-facing n8n/gotenberg URL");
  if (s.includes("sk_test_stripe_demo_public") || /demo_[A-Za-z0-9]{24,}/.test(s)) errors.push(filename+": embedded payment key forbidden");
  console.log(filename+": "+workflow.nodes.length+" nodes, disabled, webhook="+path);
}
// Verify the supplied ANCFZ demo Orders contract, not the unrelated generic
// /api/pg/{slug}/init interface.
const create=JSON.parse(readFileSync(new URL("03-mockgateway-payment-link.json",root),"utf8"));
const order=create.nodes.find(n=>n.name==="MockGateway Demo Orders POST");
const suppliedUrl="https://mockgateway.com/api/v1/public/demo/base/ancfz-f6i0ry/rest/6.0/orders/";
if(order?.parameters?.url!==suppliedUrl || order.parameters.method!=="POST")errors.push("ANCFZ Orders endpoint/method mismatch");
if(order?.parameters?.genericAuthType!=="httpHeaderAuth")errors.push("ANCFZ payment key must be private HTTP Header Auth credential");
if(!order?.parameters?.headerParameters?.parameters?.some(p=>p.name==="X-Guest-ID"&&p.value.includes("MOCKGATEWAY_GUEST_ID")))errors.push("X-Guest-ID header missing");
const orderJson=order?.parameters?.jsonBody??"";
for(const name of ["Currency","Items","UnitNetPrice","ExternalReference","BillingDetails","FirstName","Email","CountryCode","PaymentDetails","Type"]) {
  if(!orderJson.includes(name))errors.push("Demo Orders payload missing "+name);
}
if(orderJson.includes("10.00")||orderJson.includes("customer@example.com"))errors.push("Do not hardcode demo amount/customer");
const verify=JSON.parse(readFileSync(new URL("04-mockgateway-payment-verify.json",root),"utf8"));
if(verify.nodes.some(n=>n.type==="n8n-nodes-base.httpRequest"))errors.push("Unverified payment-status API must not be guessed");
if(!verify.nodes.some(n=>n.type==="n8n-nodes-base.code" && n.parameters.jsCode.includes("verified:false")))errors.push("Payment check must fail closed");
const compose=readFileSync(new URL("../docker-compose.yml",import.meta.url),"utf8");
const n8nBlock=compose.match(/\n  n8n:\n([\s\S]*?)(?=\n  [\w-]+:\n|\nnetworks:)/)?.[1] ?? "";
const pdfBlock=compose.match(/\n  gotenberg:\n([\s\S]*?)(?=\n  [\w-]+:\n|\nnetworks:)/)?.[1] ?? "";
if (!n8nBlock || !pdfBlock) errors.push("Compose missing private n8n or Gotenberg");
if(!n8nBlock.includes("N8N_ENCRYPTION_KEY:")||!n8nBlock.includes("MOCKGATEWAY_GUEST_ID:"))errors.push("n8n encryption or demo guest header configuration missing");
if(!n8nBlock.includes(":/workflows/ancfz:ro"))errors.push("n8n workflow imports must be read-only");
if (/^    ports:/m.test(n8nBlock)||/^    ports:/m.test(pdfBlock)) errors.push("n8n/Gotenberg unexpectedly publishes ports");
if (errors.length) {console.error("\n"+errors.join("\n"));process.exitCode=1;}
else console.log("ANCFZ n8n pack: structural checks PASS (provider runtime not tested)");
