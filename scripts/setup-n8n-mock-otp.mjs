#!/usr/bin/env node
/**
 * Opt-in local mock OTP extension for an ALREADY SEEDED n8n personal workspace.
 * No owner reset, SMTP credential mutation, volume reset or workflow activation.
 * Usage: node scripts/setup-n8n-mock-otp.mjs --inspect|--setup|--dry-run
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateExistingConfig } from "./seed-n8n-anzfc.mjs";

const cwd = resolve(fileURLToPath(new URL("../", import.meta.url)));
const FILES = new Map([
  ["ANCFZ | MOCK OTP Data Table Delivery (LOCAL ONLY)", "05-mock-otp-table.json"],
  ["ANCFZ | MOCK OTP Expiry Cleanup (LOCAL ONLY)", "06-mock-otp-prune.json"],
]);
function run(args, input) {
  const result = spawnSync("docker", ["compose", "--project-name", "ai-service-agent-gemini", "--profile", "workflows", ...args], {
    cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Never dump Docker stdout/stderr: request input may contain the owner API key.
    throw Error("n8n Docker operation failed; inspect local Docker status privately");
  }
  return result.stdout.trim();
}
function inspectN8n(action, apiKey) {
  const output = run(["exec", "-T", "n8n", "node", "/workflows/ancfz/setup-mock-otp.mjs"],
    JSON.stringify({ action, apiKey }));
  let response;
  try { response = JSON.parse(output); }
  catch { throw Error("n8n mock setup helper returned invalid JSON"); }
  if (response?.ok !== true) throw Error((response?.code || "SETUP_FAILED") + ": " + (response?.error || "n8n add-on setup failed"));
  return response;
}
export function validateWorkflowFiles() {
  for (const [name, file] of FILES) {
    const wf = JSON.parse(readFileSync(new URL("../infra/n8n/ancfz/" + file, import.meta.url), "utf8"));
    if (wf.name !== name || wf.active !== false) throw Error("Unexpected or active mock OTP workflow: " + file);
    if (wf.nodes.some(n => n.type === "n8n-nodes-base.emailSend")) throw Error("Mock OTP workflow must not call SMTP");
  }
}
export function parseArgs(args) {
  if (args.length !== 1 || !["--inspect", "--setup", "--dry-run"].includes(args[0])) {
    throw Error("Choose exactly one of --inspect, --setup or --dry-run; mock OTP setup is explicit");
  }
  return args[0];
}
export function main(args = process.argv.slice(2)) {
  const mode = parseArgs(args);
  validateWorkflowFiles();
  if (mode === "--dry-run") {
    console.log("Mock OTP dry run: expected table ANCFZ_POC_OTPS and 2 inactive workflows; no changes made");
    return;
  }
  const key = process.env.N8N_API_KEY;
  if (typeof key !== "string" || key.trim().length < 16) {
    throw Error("Set N8N_API_KEY privately to the existing n8n owner API key (do not paste it into commands or files)");
  }
  const config = validateExistingConfig(run(["config", "--format", "json"]));
  if (config.services?.n8n?.environment?.APP_ENV !== "development") {
    throw Error("Mock OTP add-on cannot be installed with APP_ENV=production");
  }
  const running = run(["ps", "--status", "running", "-q", "n8n"]);
  if (!running) throw Error("Start the existing n8n container first; no owner bootstrap is permitted");
  if (mode === "--inspect") {
    const info = inspectN8n("inspect", key.trim());
    console.log(JSON.stringify(info));
    return;
  }
  const plan = inspectN8n("prepare", key.trim());
  for (const name of plan.missingWorkflows) {
    const file = FILES.get(name);
    if (!file) throw Error("Unrecognized mock OTP workflow returned by setup API");
    // Import never runs against a name found in the preflight.
    run(["exec", "-T", "n8n", "n8n", "import:workflow",
      "--input=/workflows/ancfz/" + file, "--activeState=false"]);
  }
  const result = inspectN8n("verify", key.trim());
  if (!result.complete) throw Error("Mock OTP import incomplete. Re-inspect before another attempt");
  console.log("Mock OTP table installed and both workflows imported inactive. " +
    "The original SMTP workflow and credentials were not changed. " +
    "Keep production use disabled.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error("Mock OTP setup stopped: " + String(error?.message || "Unknown error"));
    process.exitCode = 1;
  }
}
