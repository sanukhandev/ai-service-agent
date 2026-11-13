#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const base = new URL("../infra/n8n/ancfz/", import.meta.url);
const creds = JSON.parse(readFileSync(new URL("credentials.template.json", base), "utf8"));
assert.equal(creds.length, 4);
const byId = new Map(creds.map(c => [c.id, c]));
assert.equal(byId.size, 4);
for(const cred of creds){
  assert.match(cred.id, /^[0-9a-f-]{36}$/);
  assert.match(cred.name, /^ANCFZ - /);
  assert.equal(typeof cred.data, "object");
  const serialized = JSON.stringify(cred.data);
  if (cred.type === "oAuth2Api") {
    assert.equal(cred.data.grantType, "clientCredentials");
    assert.equal(cred.data.authentication, "body");
    assert.equal(cred.data.accessTokenUrl, "https://techcarrot4--realforce.sandbox.my.salesforce.com/services/oauth2/token");
    assert.equal(cred.data.clientId, "xxxx");
    assert.equal(cred.data.clientSecret, "xxxx");
  } else {
    assert.match(serialized, /REPLACE_WITH_/);
  }
  assert.doesNotMatch(serialized, /demo_[A-Za-z0-9]{24,}/);
}
const mapping = {
  "Receive OTP Delivery": "httpHeaderAuth",
  "Receive Authorized Lead": "httpHeaderAuth",
  "Receive Authorized Document": "httpHeaderAuth",
  "Receive Authorized Payment": "httpHeaderAuth",
  "Receive Verification Request": "httpHeaderAuth",
  "Salesforce Apex REST Create Lead": "oAuth2Api",
  "Send ANCFZ OTP Email": "smtp",
  "MockGateway Demo Orders POST": "httpHeaderAuth",
};
const expectedId = {
  "httpHeaderAuth.webhook": "feb4e5dc-ae64-4ca8-bf87-dd1fae009fa1",
  "httpHeaderAuth.gateway": "4d9487aa-e07b-4bfd-92b9-a9699ffb5e45",
  "oAuth2Api": "3f71959e-3b35-4d0f-9d7e-2de8223ca1b8",
  "smtp": "0f33b267-e036-4cca-a147-535b59fefc7d",
};
const files=["00-otp-email.json","01-salesforce-lead.json","02-render-pdf.json","03-mockgateway-payment-link.json","04-mockgateway-payment-verify.json"];
const checked=new Set();
for(const file of files) {
  const workflow=JSON.parse(readFileSync(new URL(file,base),"utf8"));
  assert.equal(workflow.active,false);
  for(const node of workflow.nodes) {
    if(!Object.prototype.hasOwnProperty.call(mapping,node.name))continue;
    const type=mapping[node.name];
    const ref=node.credentials?.[type];
    assert(ref, file+" missing credential reference: "+node.name);
    const key=type==="httpHeaderAuth"?(node.name==="MockGateway Demo Orders POST"?"httpHeaderAuth.gateway":"httpHeaderAuth.webhook"):type;
    assert.equal(ref.id,expectedId[key]);
    assert.equal(ref.name,byId.get(ref.id).name);
    assert.equal(byId.get(ref.id).type,type);
    checked.add(node.name);
  }
}
assert.deepEqual([...checked].sort(),Object.keys(mapping).sort());

const testDir=mkdtempSync(join(tmpdir(),"ancfz-credential-test-"));
try {
  const target=join(testDir,"credentials.json");
  const environment={
    ...process.env,
    ANCFZ_N8N_WEBHOOK_SECRET:"a".repeat(48),
    ANCFZ_SMTP_HOST:"mail.example.net",
    ANCFZ_SMTP_USER:"test@example.net",
    ANCFZ_SMTP_PASSWORD:"nonproduction-smtp-password",
    ANCFZ_MOCKGATEWAY_API_KEY:"nonproduction-test-key",
  };
  const args=["scripts/prepare-ancfz-credentials.mjs","--output",target];
  let r=spawnSync(process.execPath,args,{env:environment,encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);
  const generated=JSON.parse(readFileSync(target,"utf8"));
  assert.equal(generated.length,4);
  assert.equal(generated.find(c=>c.name.includes("MockGateway")).data.value,environment.ANCFZ_MOCKGATEWAY_API_KEY);
  const sf=generated.find(c=>c.name.includes("Salesforce"));
  assert.equal(sf.type,"oAuth2Api");
  assert.equal(sf.data.clientId,"xxxx");
  assert.equal(sf.data.clientSecret,"xxxx");
  assert.equal(sf.data.grantType,"clientCredentials");
  assert.equal(generated.find(c=>c.name.includes("Webhook")).data.value,environment.ANCFZ_N8N_WEBHOOK_SECRET);
  assert.equal(statSync(target).mode & 0o777,0o600);
  // Never overwrite and never print secrets.
  r=spawnSync(process.execPath,args,{env:environment,encoding:"utf8"});
  assert.notEqual(r.status,0);
  assert(!r.stdout.includes(environment.ANCFZ_MOCKGATEWAY_API_KEY));
  // Reject missing secrets and writing inside the repository.
  const missing={...environment};delete missing.ANCFZ_MOCKGATEWAY_API_KEY;
  r=spawnSync(process.execPath,["scripts/prepare-ancfz-credentials.mjs","--output",join(testDir,"missing.json")],{env:missing,encoding:"utf8"});
  assert.notEqual(r.status,0);
  r=spawnSync(process.execPath,["scripts/prepare-ancfz-credentials.mjs","--output","./ancfz-credentials.json"],{env:environment,encoding:"utf8"});
  assert.notEqual(r.status,0);
}finally{rmSync(testDir,{recursive:true,force:true});}
console.log("ANCFZ credentials: 4 importable templates, 8 node bindings, Salesforce client credentials, safe local generation PASS");
