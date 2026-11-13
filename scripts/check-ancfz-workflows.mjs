#!/usr/bin/env node
// Static contract check only. Running n8n and provider acceptance are separate gates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  if (s.includes("sk_test_stripe_demo_public")) errors.push(filename+": cannot use public demo key");
  console.log(filename+": "+workflow.nodes.length+" nodes, disabled, webhook="+path);
}
const compose=readFileSync(new URL("../docker-compose.yml",import.meta.url),"utf8");
const n8nBlock=compose.match(/\n  n8n:\n([\s\S]*?)(?=\n  [\w-]+:\n|\nnetworks:)/)?.[1] ?? "";
const pdfBlock=compose.match(/\n  gotenberg:\n([\s\S]*?)(?=\n  [\w-]+:\n|\nnetworks:)/)?.[1] ?? "";
if (!n8nBlock || !pdfBlock) errors.push("Compose missing private n8n or Gotenberg");
if (/^    ports:/m.test(n8nBlock)||/^    ports:/m.test(pdfBlock)) errors.push("n8n/Gotenberg unexpectedly publishes ports");
if (errors.length) {console.error("\n"+errors.join("\n"));process.exitCode=1;}
else console.log("ANCFZ n8n pack: structural checks PASS (provider runtime not tested)");
