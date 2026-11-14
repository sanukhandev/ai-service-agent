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
// n8n Code Nodes support top-level await: validate as async function bodies.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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
      try { new AsyncFunction("$input", "$", "Buffer", "URL", node.parameters?.jsCode ?? ""); }
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
  for(const node of workflow.nodes) {
    for(const [kind, credential] of Object.entries(node.credentials ?? {})) {
      if(!credential || typeof credential !== "object" || Array.isArray(credential) ||
         Object.keys(credential).some(key=>key!=="id" && key!=="name") ||
         typeof credential.id !== "string" || typeof credential.name !== "string") {
        errors.push(filename+": embedded credential data or invalid reference: "+node.name+" / "+kind);
      }
    }
  }
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
// Verify the documented 2Checkout Mock REST/6.0 endpoints, not the old ANCFZ demo API.
const create=JSON.parse(readFileSync(new URL("03-mockgateway-payment-link.json",root),"utf8"));
const order=create.nodes.find(n=>n.name==="2Checkout Mock Orders POST");
const endpoint="https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/";
if(order?.parameters?.url!==endpoint||order.parameters.method!=="POST") errors.push("2Checkout order endpoint mismatch");
if(order?.parameters?.genericAuthType!=="httpHeaderAuth") errors.push("2Checkout merchant secret must be credential-bound");
if(order?.parameters?.headerParameters?.parameters?.some(p=>p.name==="X-Guest-ID")) errors.push("Legacy MockGateway X-Guest-ID must be removed");
const orderJson=order?.parameters?.jsonBody??"";
for(const name of ["Currency","Items","UnitNetPrice","ExternalReference","BillingDetails","FirstName","Email","CountryCode","PaymentDetails","Type"]) {
  if(!orderJson.includes(name)) errors.push("2Checkout order payload missing "+name);
}
if(orderJson.includes("10.00")||orderJson.includes("customer@example.com")) errors.push("Do not hardcode demo amount/customer");
const inspect=create.nodes.find(n=>n.name==="Inspect Demo Order Response")?.parameters?.jsCode??"";
for(const name of ["RefNo","GrossPrice","ExternalReference","redirect_url","verified:false"]) {
  if(!inspect.includes(name))errors.push("2Checkout create response missing validation for "+name);
}
const verify=JSON.parse(readFileSync(new URL("04-mockgateway-payment-verify.json",root),"utf8"));
const get=verify.nodes.find(n=>n.name==="2Checkout Mock GET Order");
if(get?.parameters?.method!=="GET" || !get?.parameters?.url?.includes(endpoint) ||
   get?.parameters?.genericAuthType!=="httpHeaderAuth")
  errors.push("2Checkout authenticated GET status check missing");
const code=verify.nodes.find(n=>n.name==="Validate Gateway Status")?.parameters?.jsCode??"";
for(const term of ["Status","COMPLETE","GrossPrice","Currency","ExternalReference","orderReference"]) {
  if(!code.includes(term))errors.push("2Checkout verification missing "+term);
}
const compose=readFileSync(new URL("../docker-compose.yml",import.meta.url),"utf8");
const n8nBlock=compose.match(/\n  n8n:\n([\s\S]*?)(?=\n  [\w-]+:\n|\nnetworks:)/)?.[1] ?? "";
const pdfBlock=compose.match(/\n  gotenberg:\n([\s\S]*?)(?=\n  [\w-]+:\n|\nnetworks:)/)?.[1] ?? "";
if (!n8nBlock || !pdfBlock) errors.push("Compose missing private n8n or Gotenberg");
if(!n8nBlock.includes("N8N_ENCRYPTION_KEY:"))errors.push("n8n encryption configuration missing");
if(!n8nBlock.includes(":/workflows/ancfz:ro"))errors.push("n8n workflow imports must be read-only");
if (/^    ports:/m.test(n8nBlock)||/^    ports:/m.test(pdfBlock)) errors.push("n8n/Gotenberg unexpectedly publishes ports");
if (errors.length) {console.error("\n"+errors.join("\n"));process.exitCode=1;}
else console.log("ANCFZ n8n pack: structural checks PASS (provider runtime not tested)");
