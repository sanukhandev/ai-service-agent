#!/usr/bin/env node
// Offline structural and mocked n8n API checks. Never touch Docker or real credentials.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  OWNER_EMAIL, PROJECT_NAME, WORKFLOWS, parseArgs, extractHtpasswdHash,
  validateExistingConfig, workspaceImportArgs,
} from "./seed-n8n-anzfc.mjs";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(OWNER_EMAIL, "admin@techcarrot.ae");
assert.equal(PROJECT_NAME, "anzfc");
assert.equal(WORKFLOWS.length, 5);
assert.equal(parseArgs([]).stage, "inspect");
assert.throws(() => parseArgs(["--stage=all"]));
assert.throws(() => parseArgs(["--allow-owner-update"]));
assert.equal(parseArgs([]).workspace, "personal");
assert.equal(parseArgs(["--workspace=personal", "--stage=import"]).workspace, "personal");
assert.equal(parseArgs(["--workspace=project"]).workspace, "project");
assert.equal(parseArgs(["--stage=owner"]).stage, "owner");
assert.equal(parseArgs(["--stage=inspect"]).stage, "inspect");
assert.equal(parseArgs(["--stage=import"]).stage, "import");
assert.equal(parseArgs(["--dry-run"]).dryRun, true);
assert.throws(() => parseArgs(["--workspace=unknown"]));
assert.throws(() => parseArgs(["--stage=delete"]));
assert.throws(() => parseArgs(["--reset-users"]));
assert.deepEqual(workspaceImportArgs("personal"), []);
assert.deepEqual(workspaceImportArgs("project", "AbCD1234"), ["--projectId=AbCD1234"]);
assert.throws(() => workspaceImportArgs("project", "invalid project id"));

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
assert(!source.includes('["user-management:reset"]'));
assert(!source.includes('["import:entities"]'));
assert(!helper.includes('"truncateTables": true'));
assert(helper.includes("/api/v1"));
assert(helper.includes('workspace === "project"'));
assert(helper.includes('list("/credentials")'));
assert(helper.includes('list("/workflows")'));
assert(helper.includes("Refusing duplicate or partial reseed"));
assert(source.includes("--projectId="), "Explicit project import must remain supported");
assert(source.includes("import:credentials"));
assert(source.includes("import:workflow"));
assert(source.includes("--activeState=false"));
for (const name of [
  "N8N_INSTANCE_OWNER_MANAGED_BY_ENV", "N8N_INSTANCE_OWNER_EMAIL",
  "N8N_INSTANCE_OWNER_FIRST_NAME", "N8N_INSTANCE_OWNER_LAST_NAME",
  "N8N_INSTANCE_OWNER_PASSWORD_HASH"
]) assert(compose.includes(name), "Compose missing " + name);

const files = WORKFLOWS.map(filename => JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/" + filename,import.meta.url),"utf8")));
for (const data of files) {
  assert.equal(data.active, false, "Imported workflow must never autoactivate");
  assert(data.name.startsWith("ANCFZ |"));
}
const creds=JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/credentials.template.json",import.meta.url),"utf8"));
assert.equal(creds.length,4);
assert.equal(creds.find(c => c.type === "oAuth2Api").data.clientId,"xxxx");

let run=spawnSync(process.execPath,["scripts/seed-n8n-anzfc.mjs","--dry-run"],{cwd,encoding:"utf8"});
assert.equal(run.status,0,run.stderr);
assert(run.stdout.includes("No Docker, database, provider or network calls made"));
assert(run.stdout.includes("workspace=personal"));
assert(run.stdout.includes("project=none"));
run=spawnSync(process.execPath,["scripts/seed-n8n-anzfc.mjs","--workspace=project","--dry-run"],{cwd,encoding:"utf8"});
assert.equal(run.status,0,run.stderr);
assert(run.stdout.includes("workspace=project"));
assert(run.stdout.includes("project=anzfc"));
run=spawnSync(process.execPath,["--check","infra/n8n/ancfz/seed-project.mjs"],{cwd,encoding:"utf8"});
assert.equal(run.status,0,run.stderr);

// Mock only the public n8n API with --import preload, to prove that personal
// mode never attempts /projects, rejects existing resources, and verifies
// exactly the four credential IDs and five inactive workflow names.
const testDir=mkdtempSync(join(tmpdir(),"ancfz-personal-seed-"));
try {
  const preloadPath=join(testDir,"mock-n8n-api.mjs");
  const fixtureCredentials=creds.map(c => ({id:c.id,name:c.name}));
  const fixtureWorkflows=files.map(w => ({name:w.name,active:false}));
  writeFileSync(preloadPath, `
    const existingCredentials = ${JSON.stringify(fixtureCredentials)};
    const existingWorkflows = ${JSON.stringify(fixtureWorkflows)};
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path.includes("/projects")) throw Error("Unexpected Projects API request");
      const mode = process.env.ANCFZ_SEED_FIXTURE;
      const data = path.includes("/credentials")
        ? (mode === "empty" ? [] : mode === "partial" ? existingCredentials.slice(0, 1) : existingCredentials)
        : path.includes("/workflows")
          ? (mode === "empty" ? [] : mode === "partial" ? existingWorkflows.slice(0, 1) : existingWorkflows)
          : (() => { throw Error("Unexpected API request: " + path); })();
      return new Response(JSON.stringify({data}), {status:200,headers:{"Content-Type":"application/json"}});
    };
  `);
  const request={
    workspace:"personal",apiKey:"x".repeat(40),projectName:"anzfc",
    credentialIds:fixtureCredentials,workflowNames:fixtureWorkflows.map(w=>w.name),
  };
  function simulate(action, fixture) {
    const proc=spawnSync(process.execPath,["--import",preloadPath,"infra/n8n/ancfz/seed-project.mjs"],{
      cwd,env:{...process.env,ANCFZ_SEED_FIXTURE:fixture},
      input:JSON.stringify({...request,action}),encoding:"utf8",
    });
    assert.equal(proc.status,0,proc.stderr);
    return JSON.parse(proc.stdout);
  }
  const empty=simulate("prepare","empty");
  assert.equal(empty.ok,true);
  assert.equal(empty.workspace,"personal");
  assert.equal(empty.projectId,undefined);
  assert.equal(empty.alreadySeeded,false);
  const completed=simulate("prepare","existing");
  assert.equal(completed.ok,true);
  assert.equal(completed.alreadySeeded,true, "A complete inactive setup must not overwrite anything");
  const ready=simulate("inspect","existing");
  assert.equal(ready.ok,true);
  assert.equal(ready.status,"ready");
  assert.equal(ready.matchingCredentials,4);
  assert.equal(ready.matchingInactiveWorkflows,5);
  const none=simulate("inspect","empty");
  assert.equal(none.status,"empty");
  const partial=simulate("inspect","partial");
  assert.equal(partial.status,"partial");
  assert.equal(partial.matchingCredentials,1);
  assert.equal(partial.matchingInactiveWorkflows,1);
  const blocked=simulate("prepare","partial");
  assert.equal(blocked.ok,false);
  assert.match(blocked.error,/Refusing duplicate or partial reseed/);
  const verified=simulate("verify","existing");
  assert.equal(verified.ok,true);
  assert.equal(verified.alreadySeeded,true);
  const notSeeded=simulate("verify","empty");
  assert.equal(notSeeded.alreadySeeded,false);
} finally {
  rmSync(testDir,{recursive:true,force:true});
}

console.log("ANCFZ n8n seed PASS: default inspect, personal workspace, idempotent complete import, partial import rejection, no Projects API, inactive imports");
