#!/usr/bin/env node
// Static and sandbox-data-only ANCFZ Salesforce Apex REST contract tests.
// Does not authenticate against Salesforce or create a real lead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = new URL("../infra/n8n/ancfz/", import.meta.url);
const workflow = JSON.parse(readFileSync(new URL("01-salesforce-lead.json",base),"utf8"));
const imported = JSON.parse(readFileSync(new URL("credentials.template.json",base),"utf8"));
assert.equal(workflow.active,false);
assert.deepEqual(workflow.nodes.map(n=>n.name),[
  "Receive Authorized Lead","Validate ANCFZ Lead",
  "Salesforce Apex REST Create Lead","Inspect Apex REST Lead Result","Respond"
]);
const request=workflow.nodes.find(n=>n.name==="Salesforce Apex REST Create Lead");
assert.equal(request.parameters.method,"POST");
assert.equal(request.parameters.url,"https://techcarrot4--realforce.sandbox.my.salesforce.com/services/apexrest/AIChatbotLead/");
assert.equal(request.parameters.authentication,"genericCredentialType");
assert.equal(request.parameters.genericAuthType,"oAuth2Api");
assert.equal(request.parameters.specifyBody,"json");
assert(!JSON.stringify(request).includes("$env."));
assert(!JSON.stringify(request).includes("Cookie"));
assert(!JSON.stringify(request).includes("Bearer "));
assert(!JSON.stringify(request).includes("salesforceOAuth2Api"));
assert(!JSON.stringify(request).includes("/sobjects/Lead/"));
const credential=imported.find(c=>c.id==="3f71959e-3b35-4d0f-9d7e-2de8223ca1b8");
assert.equal(credential.type,"oAuth2Api");
assert.equal(credential.data.grantType,"clientCredentials");
assert.equal(credential.data.authentication,"body");
assert.equal(credential.data.clientId,"xxxx");
assert.equal(credential.data.clientSecret,"xxxx");
assert.equal(credential.data.accessTokenUrl,"https://techcarrot4--realforce.sandbox.my.salesforce.com/services/oauth2/token");
assert.deepEqual(request.credentials.oAuth2Api,{id:credential.id,name:credential.name});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const validate = new AsyncFunction("$input","$",workflow.nodes.find(n=>n.name==="Validate ANCFZ Lead").parameters.jsCode);
const response = new AsyncFunction("$input","$",workflow.nodes.find(n=>n.name==="Inspect Apex REST Lead Result").parameters.jsCode);
const ticketId="123e4567-e89b-42d3-a456-426614174000";
const original={
 agentKey:"ancfz",ticketId,consent:true,
 name:"Test Customer",company:"Test Organization",phone:"+971 50 111 2222",
 email:"sandbox@example.net",description:"Sandbox ANCFZ business enquiry"
};
const validated=await validate({first:()=>({json:{body:original}})},()=>{});
assert.equal(validated.length,1);
assert.equal(validated[0].json.ticketId,ticketId);
assert.deepEqual(validated[0].json.lead,{
 Name:"Test Customer",Company:"Test Organization",Phone:"+971 50 111 2222",
 Email:"sandbox@example.net",Description:"Sandbox ANCFZ business enquiry"
});
const payloadExpression=request.parameters.jsonBody;
assert(payloadExpression.includes("JSON.stringify($('Validate ANCFZ Lead').first().json.lead)"));
assert(!payloadExpression.includes("sandbox@example.net"));
for(const bad of [
 {...original,consent:false},
 {...original,agentKey:"other"},
 {...original,phone:"bad"},
 {...original,email:"invalid"},
 {...original,name:""},
 {...original,ticketId:"not-uuid"}
]){
 await assert.rejects(validate({first:()=>({json:{body:bad}})},()=>{}));
}
const scope=(name)=>{assert.equal(name,"Validate ANCFZ Lead");return{first:()=>({json:{ticketId}})}};
const existing="00Q"+"A".repeat(12);
const good=await response({first:()=>({json:{success:true,leadId:existing}})},scope);
assert.deepEqual(good[0].json,{status:"verified_completed",provider:"salesforce_apex_rest",ticketId,leadId:existing,verified:true});
const unknown=await response({first:()=>({json:{message:"received"}})},scope);
assert.equal(unknown[0].json.status,"provider_acknowledged_unverified");
assert.equal(unknown[0].json.verified,false);
assert.equal(unknown[0].json.leadId,null);
await assert.rejects(response({first:()=>({json:{success:false,message:"blocked"}})},scope));
console.log("ANCFZ Salesforce Apex REST: sandbox-payload contract checks PASS (live provider unverified)");
