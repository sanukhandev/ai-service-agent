#!/usr/bin/env node
/**
 * ANZFC (ANCFZ integrations) n8n database bootstrap.
 *
 * Uses official n8n owner provisioning (>=2.17) and n8n CLI imports.
 * Deliberately DOES NOT write n8n internal SQLite/Postgres tables directly.
 *
 * Fresh instances require two explicit stages; existing instances use import only:
 *   N8N_OWNER_PASSWORD=<private runtime value> node scripts/seed-n8n-anzfc.mjs --stage=owner
 *   N8N_API_KEY=<owner-created key> node scripts/seed-n8n-anzfc.mjs --stage=import
 *   No arguments: read-only inspect. No implicit owner changes or workflow activation.
 * Imports into the owner's personal workspace by default, without Projects API.
 * Use --workspace=project only on n8n instances with project permissions.
 *
 * The password is NEVER encoded into scripts, Compose files or CLI arguments.
 * Project imports require the n8n Projects entitlement; no personal-space fallback.
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
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
  const phases = ["inspect", "owner", "import", "setup"];
  const workspaces = ["personal", "project"];
  let workspace = "personal";
  let stage = "inspect";
  let dryRun = false;
  for (const arg of args) {
    if (arg.startsWith("--stage=")) {
      stage = arg.slice(8);
      if (!phases.includes(stage)) throw new Error("Invalid --stage; choose inspect, owner, import or setup (owner is always separate)");
    } else if (arg.startsWith("--workspace=")) {
      workspace = arg.slice("--workspace=".length);
      if (!workspaces.includes(workspace)) throw new Error("Invalid --workspace; choose personal or project");
    } else if (arg === "--dry-run") dryRun = true;
    else throw new Error("Unknown argument: " + arg);
  }
  return { stage, workspace, dryRun };
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

export function seedOwner() {
  const password = process.env.N8N_OWNER_PASSWORD;
  if (!password || password.length < 12 || password.includes("\n") || password.includes("\r")) {
    throw new Error("Set N8N_OWNER_PASSWORD in a private environment (minimum 12 characters) before --stage=owner");
  }
  // Validate Compose before touching a running container or its owner.
  const config = validateExistingConfig(compose(["config", "--format", "json"]));
  // A stopped/deleted container can still have a populated SQLite database in
  // its named volume. Guard the volume itself, not only running containers.
  const volumeName = config?.volumes?.["n8n-data"]?.name ??
    (String(config.name || "ai-service-agent") + "_n8n-data");
  if (!/^[A-Za-z0-9_.-]{3,200}$/.test(volumeName)) throw new Error("Unexpected n8n volume identifier");
  const volumes = docker(["volume", "ls", "--format", "{{.Name}}"]).split(/\r?\n/).filter(Boolean);
  if (isN8nRunning() || volumes.includes(volumeName)) {
    throw new Error("Existing n8n instance or data volume detected. Owner bootstrap is for fresh instances only; use --stage=inspect or --stage=import without changing the owner.");
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

/** The n8n server CLI defaults to the global owner's personal workspace. */
export function workspaceImportArgs(workspace, projectId) {
  if (workspace === "personal") return [];
  if (workspace === "project" && typeof projectId === "string" && /^[A-Za-z0-9_-]{4,100}$/.test(projectId)) {
    return ["--projectId=" + projectId];
  }
  throw new Error("Explicit project imports require a valid n8n project ID");
}

export function seedWorkspace({ workspace = "personal", inspectOnly = false } = {}) {
  if (!["personal", "project"].includes(workspace)) throw new Error("Unknown n8n workspace mode");
  const apiKey = process.env.N8N_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length < 16) {
    throw new Error("N8N_API_KEY is required. Log into n8n as the owner, create an API key under Settings > n8n API, then retry --stage=import");
  }
  validateExistingConfig(compose(["config", "--format", "json"]));
  if (!isN8nRunning()) throw new Error("n8n is not running. Start it with the workflows profile before --stage=import");

  // Preflight every expected name and credential ID before writing anything.
  // Personal mode MUST NOT call /projects: Community instances can return 403.
  const outcome = privateApiRequest({
    action: inspectOnly ? "inspect" : "prepare", workspace, apiKey: apiKey.trim(), projectName: PROJECT_NAME,
    credentialIds: credentialIds(), workflowNames: workflowNames(),
  });
  if (inspectOnly) {
    console.log("n8n workspace inspection: " + JSON.stringify({
      workspace, status: outcome.status, matchingCredentials: outcome.matchingCredentials,
      matchingInactiveWorkflows: outcome.matchingInactiveWorkflows,
      totalCredentials: 4, totalWorkflows: WORKFLOWS.length,
    }));
    return;
  }
  if (outcome.alreadySeeded) {
    console.log("n8n ANCFZ assets are already seeded: 4 matching credentials and 5 inactive workflows. No changes made.");
    return;
  }
  const projectId = workspace === "project" ? outcome.projectId : undefined;
  const destination = workspaceImportArgs(workspace, projectId);
  console.log(workspace === "personal"
    ? "Owner personal workspace selected; importing disabled ANCFZ assets."
    : "Project " + PROJECT_NAME + " resolved as " + projectId + "; importing disabled ANCFZ assets.");

  // Credentials must come first, since workflow nodes reference their fixed IDs.
  // Refuse preexisting assets rather than overwrite real credential secrets.
  compose(["exec", "-T", "n8n", "n8n", "import:credentials",
    "--input=/workflows/ancfz/credentials.template.json", ...destination], { silent: true });
  for (const file of WORKFLOWS) {
    compose(["exec", "-T", "n8n", "n8n", "import:workflow",
      "--input=/workflows/ancfz/" + file,
      ...destination, "--activeState=false"], { silent: true });
  }
  const verified = privateApiRequest({
    action: "verify", workspace, apiKey: apiKey.trim(), projectName: PROJECT_NAME,
    ...(projectId ? { projectId } : {}),
    credentialIds: credentialIds(), workflowNames: workflowNames(),
  });
  if (!verified.alreadySeeded) {
    throw new Error("n8n CLI imports finished, but API could not verify all four credentials and five inactive workflows");
  }
  console.log("Verified n8n " + (workspace === "personal" ? "owner personal workspace" : "project " + PROJECT_NAME) +
    ": 4 credential placeholders and 5 inactive ANCFZ workflows.");
  console.log("Set real credential values in the n8n UI before activating any workflow.");
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
/**
 * One-command setup for an ALREADY OWNED local instance. Never provisions or
 * updates an owner; never activates workflows or replaces saved credentials.
 * Waiting is limited to a read-only API inspection. Imports are never retried.
 */
export async function setupWorkspace({ workspace = "personal" } = {}) {
  if (!["personal", "project"].includes(workspace)) throw new Error("Unknown n8n workspace mode");
  const apiKey = process.env.N8N_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length < 16) {
    throw new Error("N8N_API_KEY is required for setup. Create an owner API key in n8n first; owner provisioning is a separate --stage=owner operation.");
  }
  validateExistingConfig(compose(["config", "--format", "json"]));
  compose(["up", "-d", "n8n", "gotenberg"], { silent: true, timeout: 240_000 });
  const inspect = {
    action: "inspect", workspace, apiKey: apiKey.trim(), projectName: PROJECT_NAME,
    credentialIds: credentialIds(), workflowNames: workflowNames(),
  };
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      privateApiRequest(inspect);
      ready = true;
      break;
    } catch (error) {
      const message = String(error?.message || "");
      if (/API key is invalid|API key is missing permission|Projects API is not available/.test(message)) {
        throw error;
      }
      if (attempt === 19) throw new Error("n8n API did not become ready; inspect Docker logs and run --stage=inspect");
      await sleep(1000);
    }
  }
  if (!ready) throw new Error("n8n API unavailable");
  // Import is deliberately invoked only once after readiness, not inside a retry loop.
  seedWorkspace({ workspace });
}

export async function main(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.dryRun) {
    console.log("Dry run: owner=" + OWNER_EMAIL + ", workspace=" + opts.workspace +
      ", project=" + (opts.workspace === "project" ? PROJECT_NAME : "none") +
      ", credentials=4 placeholders, inactiveWorkflows=" + workflowNames().length +
      ", stage=" + opts.stage + ". No Docker, database, provider or network calls made.");
    return;
  }
  if (opts.stage === "owner") seedOwner();
  else if (opts.stage === "setup") await setupWorkspace({ workspace: opts.workspace });
  else seedWorkspace({ workspace: opts.workspace, inspectOnly: opts.stage === "inspect" });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(err => {
    console.error("ANZFC n8n seed stopped: " + err.message);
    process.exitCode = 1;
  });
}
