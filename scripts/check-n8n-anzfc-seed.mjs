#!/usr/bin/env node
// Structural tests; no real Docker or n8n database is touched.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_EMAIL, PROJECT_NAME, WORKFLOWS, parseArgs, extractHtpasswdHash, validateExistingConfig } from "./seed-n8n-anzfc.mjs";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(OWNER_EMAIL, "admin@techcarrot.ae");
assert.equal(PROJECT_NAME, "anzfc");
assert.equal(WORKFLOWS.length, 5);
assert.equal(parseArgs([]).stage, "all");
assert.equal(parseArgs(["--stage=owner"]).stage, "owner");
assert.equal(parseArgs(["--stage=import"]).stage, "import");
assert.equal(parseArgs(["--dry-run"]).dryRun, true);
assert.throws(() => parseArgs(["--stage=delete"]));
assert.throws(() => parseArgs(["--reset-users"]));

const exampleHash = "$2y$12$" + "a".repeat(53);
assert.equal(extractHtpasswdHash("owner:" + exampleHash + "\n"), "$2b$12$" + "a".repeat(53));
assert.throws(() => extractHtpasswdHash("owner:not-a-bcrypt-hash"));
const base = { services: { n8n: { environment: { N8N_ENCRYPTION_KEY: "x".repeat(40) } } } };
assert.deepEqual(validateExistingConfig(JSON.stringify(base)), base);
assert.throws(() => validateExistingConfig(JSON.stringify({services:{n8n:{environment:{N8N_ENCRYPTION_KEY:"short"}}}})));
assert.throws(() => validateExistingConfig(JSON.stringify({services:{n8n:{environment:{N8N_ENCRYPTION_KEY:"x".repeat(40)},ports:["5678:5678"]}}})));

const source=readFileSync(new URL("./seed-n8n-anzfc.mjs",import.meta.url),"utf8");
const helper=readFileSync(new URL("../infra/n8n/ancfz/seed-project.mjs",import.meta.url),"utf8");
const compose=readFileSync(new URL("../docker-compose.yml",import.meta.url),"utf8");
assert(!source.includes("techCarrot@2026"), "Do not hardcode the supplied owner password");
assert(!source.includes("user-management:reset"));
assert(!source.includes("import:entities"));
assert(!helper.includes("truncateTables"));
assert(helper.includes("/api/v1"));
assert(helper.includes("/projects"));
assert(helper.includes("Credential ID collision"));
assert(helper.includes("No personal-project fallback"));
assert(source.includes("--projectId="));
assert(source.includes("import:credentials"));
assert(source.includes("import:workflow"));
assert(source.includes("--activeState=false"));
for(const name of [
"N8N_INSTANCE_OWNER_MANAGED_BY_ENV", "N8N_INSTANCE_OWNER_EMAIL",
"N8N_INSTANCE_OWNER_FIRST_NAME", "N8N_INSTANCE_OWNER_LAST_NAME",
"N8N_INSTANCE_OWNER_PASSWORD_HASH"
])assert(compose.includes(name), "Compose missing " + name);

for (const filename of WORKFLOWS) {
  const data=JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/"+filename,import.meta.url),"utf8"));
  assert.equal(data.active,false, filename+" must never autoactivate");
  assert(data.name.startsWith("ANCFZ |"), "Expected ANCFZ workflow prefix");
}
const creds=JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/credentials.template.json",import.meta.url),"utf8"));
assert.equal(creds.length,4);
assert.equal(creds.find(c=>c.type==="oAuth2Api").data.clientId,"xxxx");

let run=spawnSync(process.execPath,["scripts/seed-n8n-anzfc.mjs","--stage=all","--dry-run"],{cwd,encoding:"utf8"});
assert.equal(run.status,0,run.stderr);
assert(run.stdout.includes("No Docker, database, provider or network calls made"));
assert(run.stdout.includes("project=anzfc"));
run=spawnSync(process.execPath,["--check","infra/n8n/ancfz/seed-project.mjs"],{cwd,encoding:"utf8"});
assert.equal(run.status,0,run.stderr);

console.log("ANZFC n8n seed: owner bcrypt, project API, import contracts, credential placeholders and no-side-effect dry run PASS");
