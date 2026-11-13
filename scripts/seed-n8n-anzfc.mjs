#!/usr/bin/env node
/**
 * ANZFC (ANCFZ integrations) n8n database bootstrap.
 *
 * Uses official n8n owner provisioning (>=2.17) and n8n CLI imports.
 * Deliberately DOES NOT write n8n internal SQLite/Postgres tables directly.
 *
 * Two stages on a new instance:
 *   N8N_OWNER_PASSWORD=<private runtime value> node scripts/seed-n8n-anzfc.mjs --stage=owner
 *   N8N_API_KEY=<owner-created key> node scripts/seed-n8n-anzfc.mjs --stage=import
 *
 * The password is NEVER encoded into scripts, Compose files or CLI arguments.
 * Project imports require the n8n Projects entitlement; no personal-space fallback.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const OWNER_EMAIL = "admin@techcarrot.ae";
export const PROJECT_NAME = "anzfc"; // User-requested exact workspace spelling.
export const WORKFLOWS = [
  "00-otp-email.json",
  "01-salesforce-lead.json",
  "02-render-pdf.json",
  "03-mockgateway-payment-link.json",
  "04-mockgateway-payment-verify.json",
];

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const MIN_ENCRYPTION_LENGTH = 32;

export function parseArgs(args) {
  const phases = ["owner", "import", "all"];
  let stage = "all";
  let dryRun = false;
  let allowOwnerUpdate = false;
  for (const arg of args) {
    if (arg.startsWith("--stage=")) {
      stage = arg.slice(8);
      if (!phases.includes(stage)) throw new Error("Invalid --stage; choose owner, import or all");
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--allow-owner-update") allowOwnerUpdate = true;
    else throw new Error("Unknown argument: " + arg);
  }
  return { stage, dryRun, allowOwnerUpdate };
}

export function extractHtpasswdHash(text) {
  const match = String(text).trim().match(/^owner:(\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53})$/);
  if (!match) throw new Error("bcrypt hasher returned an unexpected result");
  // Apache htpasswd often returns 2y; Node bcrypt consumers expect 2b.
  return match[1].replace(/^\$2y\$/, "$2b$");
}

function run(program, args, { env, input, silent = false, timeout = 180_000 } = {}) {
  const call = spawnSync(program, args, {
    cwd: repoRoot,
    env: env ?? process.env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (call.error) throw new Error(program + " could not start: " + call.error.message);
  if (call.status !== 0) {
    // Never echo stderr for commands receiving secrets: some CLIs print env on error.
    if (silent) throw new Error(program + " operation failed; inspect local Docker status privately");
    const diagnostic = (call.stderr || call.stdout || "").replace(/[\r\n]+/g, " ").slice(0, 360);
    throw new Error(program + " exited " + call.status + ": " + diagnostic);
  }
  return call.stdout.trim();
}

function docker(args, options = {}) {
  return run("docker", args, options);
}
function compose(args, options = {}) {
  return docker(["compose", "--profile", "workflows", ...args], options);
}
function isN8nRunning() {
  const id = compose(["ps", "--status", "running", "-q", "n8n"]);
  return Boolean(id.trim());
}

export function validateExistingConfig(raw) {
  const parsed = JSON.parse(raw);
  const encryptionKey = parsed?.services?.n8n?.environment?.N8N_ENCRYPTION_KEY;
  if (typeof encryptionKey !== "string" || encryptionKey.length < MIN_ENCRYPTION_LENGTH) {
    throw new Error("Set a strong persistent N8N_ENCRYPTION_KEY (at least 32 characters) in local .env before bootstrapping");
  }
  if (parsed?.services?.n8n?.ports?.length) {
    throw new Error("n8n must not expose host ports");
  }
  return parsed;
}

export function seedOwner({ allowOwnerUpdate = false } = {}) {
  const password = process.env.N8N_OWNER_PASSWORD;
  if (!password || password.length < 12 || password.includes("\n") || password.includes("\r")) {
    throw new Error("Set N8N_OWNER_PASSWORD in a private environment (minimum 12 characters) before --stage=owner");
  }
  // Validate Compose before touching a running container or its owner.
  validateExistingConfig(compose(["config", "--format", "json"]));
  if (isN8nRunning() && !allowOwnerUpdate) {
    throw new Error("n8n is already running. Owner bootstrap may update an existing owner. Re-run with --allow-owner-update only after verifying this instance and backing up its n8n DB");
  }
  // Use htpasswd as a one-shot bcrypt implementation; receive plaintext ONLY
  // over stdin (never as an argv/Compose value or checked-in file).
  const hash = extractHtpasswdHash(docker(
    ["run", "--rm", "-i", "httpd:2.4-alpine", "htpasswd", "-niB", "-C", "12", "owner"],
    { input: password + "\n", silent: true },
  ));
  const env = { ...process.env };
  delete env.N8N_OWNER_PASSWORD;
  env.N8N_INSTANCE_OWNER_MANAGED_BY_ENV = "true";
  env.N8N_INSTANCE_OWNER_EMAIL = OWNER_EMAIL;
  env.N8N_INSTANCE_OWNER_FIRST_NAME = "Techcarrot";
  env.N8N_INSTANCE_OWNER_LAST_NAME = "Admin";
  env.N8N_INSTANCE_OWNER_PASSWORD_HASH = hash;
  compose(["up", "-d", "n8n", "gotenberg"], { env, silent: true, timeout: 240_000 });
  console.log("Started n8n with bcrypt-hashed owner provisioning for " + OWNER_EMAIL + ".");
  console.log("Owner configuration remains enforced while these Compose variables are present in the container. Do not use this command as a password-reset mechanism on an existing instance.");
}

function privateApiRequest(payload) {
  // API key flows through stdin, never through Docker argv or environment.
  const out = compose(["exec", "-T", "n8n", "node", "/workflows/ancfz/seed-project.mjs"], {
    input: JSON.stringify(payload),
    silent: true,
    timeout: 90_000,
  });
  let response;
  try { response = JSON.parse(out); }
  catch { throw new Error("Private n8n project helper returned non-JSON data; inspect the n8n instance locally"); }
  if (!response || response.ok !== true) {
    // Diagnostic has no secrets; helper returns fixed sanitized messages.
    throw new Error(response?.error || "n8n project operation failed");
  }
  return response;
}

export function seedProject() {
  const apiKey = process.env.N8N_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length < 16) {
    throw new Error("N8N_API_KEY is required for the supported Projects API. Log into n8n as the owner, create an API key under Settings > n8n API, then retry --stage=import");
  }
  validateExistingConfig(compose(["config", "--format", "json"]));
  if (!isN8nRunning()) throw new Error("n8n is not running. Start it with the workflows profile before --stage=import");

  // The first phase preflights existing resources and creates/reuses the named
  // project. It will not overwrite an existing import or a foreign credential.
  const outcome = privateApiRequest({
    action: "prepare", apiKey: apiKey.trim(), projectName: PROJECT_NAME,
    credentialIds: credentialIds(), workflowNames: workflowNames(),
  });
  const projectId = outcome.projectId;
  if (typeof projectId !== "string" || !/^[A-Za-z0-9_-]{4,100}$/.test(projectId)) {
    throw new Error("n8n returned invalid project ID");
  }
  console.log("Project " + PROJECT_NAME + " resolved as " + projectId + "; importing disabled ANCFZ assets.");
  // CLI imports use n8n's configured database and encryption key.
  // NEVER use import:entities --truncateTables or user-management:reset.
  compose(["exec", "-T", "n8n", "n8n", "import:credentials",
    "--input=/workflows/ancfz/credentials.template.json", "--projectId=" + projectId], { silent: true });
  for (const file of WORKFLOWS) {
    compose(["exec", "-T", "n8n", "n8n", "import:workflow",
      "--input=/workflows/ancfz/" + file,
      "--projectId=" + projectId, "--activeState=false"], { silent: true });
  }
  const verified = privateApiRequest({
    action: "verify", apiKey: apiKey.trim(), projectName: PROJECT_NAME,
    projectId, credentialIds: credentialIds(), workflowNames: workflowNames(),
  });
  if (!verified.alreadySeeded) throw new Error("n8n CLI imports finished, but API could not verify all four credentials and five inactive workflows");
  console.log("Verified n8n project " + PROJECT_NAME + ": 4 credential placeholders and 5 inactive ANCFZ workflows.");
  console.log("Complete real credential values in the n8n UI before using the workflows. Do not publish/activate them yet.");
}

function credentialIds() {
  const list = JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/credentials.template.json", import.meta.url), "utf8"));
  if (!Array.isArray(list) || list.length !== 4) throw new Error("Expected exactly 4 ANCFZ credentials");
  return list.map(c => ({ id: c.id, name: c.name }));
}
function workflowNames() {
  return WORKFLOWS.map(file => {
    const w = JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/" + file, import.meta.url), "utf8"));
    if (w.active !== false) throw new Error("Seed refuses active workflow: " + file);
    return w.name;
  });
}
export function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.dryRun) {
    console.log("Dry run: owner=" + OWNER_EMAIL + ", project=" + PROJECT_NAME +
      ", credentials=4 placeholders, inactiveWorkflows=" + workflowNames().length +
      ", stage=" + opts.stage + ". No Docker, database, provider or network calls made.");
    return;
  }
  if (opts.stage === "owner" || opts.stage === "all") seedOwner(opts);
  if (opts.stage === "import" || opts.stage === "all") seedProject();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (err) { console.error("ANZFC n8n seed stopped: " + err.message); process.exitCode = 1; }
}
