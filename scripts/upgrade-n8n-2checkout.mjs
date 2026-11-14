#!/usr/bin/env node
/**
 * Offline-safe operator control for upgrading exactly three existing inactive
 * n8n workflows. Requires real owner API key over Docker stdin only.
 *
 * --inspect: read only
 * --backup:  inspect and save three full definitions outside repository
 * --apply:   inspect, save backups, then update in place; always inactive
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { validateExistingConfig } from "./seed-n8n-anzfc.mjs";

const cwd = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SAFE_ID = /^[A-Za-z0-9_-]{1,150}$/;
function docker(args, input) {
  const result = spawnSync("docker", ["compose", "--profile", "workflows", ...args], {
    cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    timeout: 90000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Never echo Docker stdout/stderr: invocation may include private key data.
    throw Error("Private Docker operation failed; inspect container state locally");
  }
  return result.stdout.trim();
}
export function parseArgs(args) {
  if (args.length !== 1 || !["--inspect", "--backup", "--apply", "--dry-run"].includes(args[0])) {
    throw Error("Use exactly one of --inspect, --backup, --apply, --dry-run");
  }
  return args[0];
}
function helper(action, key, expected) {
  const data = { action, apiKey: key, ...(expected ? { expected } : {}) };
  const output = docker(
    ["exec", "-T", "n8n", "node", "/workflows/ancfz/upgrade-2checkout.mjs"],
    JSON.stringify(data),
  );
  let response;
  try { response = JSON.parse(output); }
  catch { throw Error("Private upgrader returned unreadable JSON"); }
  if (response?.ok !== true) {
    const code = typeof response?.code === "string" ? response.code : "UPGRADE_FAILED";
    throw Error(code + ": " + String(response?.error || "Workflow upgrade stopped").slice(0, 250));
  }
  return response;
}
function saveBackups(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length !== 3) {
    throw Error("Cannot write a backup: exactly three invoice/payment workflows are required");
  }
  const root = join(homedir(), "ai-service-agent-n8n-backups");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(root, "2checkout-"));
  chmodSync(folder, 0o700);
  const manifest = [];
  for (const item of snapshot) {
    if (!SAFE_ID.test(item.id) || !/^[a-f0-9]{64}$/.test(item.hash) ||
        !item.document || item.document.id !== item.id || item.document.active !== false) {
      throw Error("Backup rejected because n8n returned incomplete workflow data");
    }
    const target = join(folder, item.id + ".json");
    writeFileSync(target, JSON.stringify(item.document, null, 2) + "\n", {
      flag: "wx", mode: 0o600,
    });
    manifest.push({ id: item.id, path: item.path, hash: item.hash });
  }
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx", mode: 0o600,
  });
  return { folder, expected: manifest.map(({ id, hash }) => ({ id, hash })) };
}
export function main(args = process.argv.slice(2)) {
  const action = parseArgs(args);
  if (action === "--dry-run") {
    console.log("2Checkout mock upgrade dry run: three existing inactive payment workflows; no Docker/provider/credential changes");
    return;
  }
  const key = process.env.N8N_API_KEY;
  if (typeof key !== "string" || key.trim().length < 16) {
    throw Error("Enter an existing n8n owner API key privately in N8N_API_KEY");
  }
  const config = validateExistingConfig(docker(["config", "--format", "json"]));
  if (config.services?.n8n?.environment?.APP_ENV !== "development") {
    throw Error("2Checkout mock upgrades are allowed only in development");
  }
  if (!docker(["ps", "--status", "running", "-q", "n8n"])) {
    throw Error("The existing n8n owner container must be running");
  }

  if (action === "--inspect") {
    const status = helper("inspect", key.trim());
    console.log(JSON.stringify(status));
    return;
  }
  const evidence = helper("snapshot", key.trim());
  const backup = saveBackups(evidence.snapshot);
  console.log("Saved three inactive workflow backups at: " + backup.folder);
  if (action === "--backup") return;

  // The helper rechecks both live definitions and refuses mutation if their
  // SHA256 fingerprints changed after the local backup was written.
  const result = helper("apply", key.trim(), backup.expected);
  if (!result.applied) throw Error("n8n workflow apply did not confirm completion");
  console.log(JSON.stringify({ ok: true, applied: true, workflows: result.workflows }));
  console.log("Updated invoice/payment workflows remain INACTIVE. Update the rotated merchant Header Auth credential manually.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error("2Checkout upgrade stopped: " + String(error?.message || "Unknown error"));
    process.exitCode = 1;
  }
}
