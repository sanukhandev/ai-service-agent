#!/usr/bin/env node
/**
 * Private n8n bootstrap helper, executed inside the n8n Docker container.
 *
 * Owner-personal workspace (the default) deliberately never calls /projects.
 * Optional named-project mode requires a Projects entitlement and explicit
 * --workspace=project from the host seeder.
 *
 * Only supported public n8n API reads and project creation are used.
 * No direct SQLite writes, account resets or credential overwrites.
 * API keys arrive through stdin and are never logged.
 */
const URL_BASE = "http://127.0.0.1:5678";
const MAX_INPUT = 16384;
const validName = value => typeof value === "string" && value.length >= 3 && value.length < 100;
const validId = value => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

async function readInput() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString("utf8");
    if (data.length > MAX_INPUT) throw new Error("Invalid bootstrap request size");
  }
  return JSON.parse(data);
}

async function main() {
  const {
    action, workspace = "personal", apiKey, projectName, projectId,
    credentialIds, workflowNames,
  } = await readInput();
  if (!["prepare", "verify"].includes(action) ||
      !["personal", "project"].includes(workspace) ||
      (workspace === "project" && !validName(projectName)) ||
      typeof apiKey !== "string" || apiKey.trim().length < 16 ||
      !Array.isArray(credentialIds) || credentialIds.length !== 4 ||
      !credentialIds.every(c => validId(c.id) && validName(c.name)) ||
      !Array.isArray(workflowNames) || workflowNames.length !== 5 ||
      !workflowNames.every(validName)) {
    throw new Error("Invalid workspace bootstrap parameters");
  }

  async function api(method, path, body) {
    const res = await fetch(new URL("/api/v1" + path, URL_BASE), {
      method,
      headers: {
        "X-N8N-API-KEY": apiKey.trim(),
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if ((res.status === 402 || res.status === 403) && path.startsWith("/projects")) {
        throw new Error("n8n Projects API is not available for this key/edition. Use --workspace=personal (the default) or grant project permissions.");
      }
      if (res.status === 401) throw new Error("n8n API key is invalid or expired for " + path.split("?")[0]);
      if (res.status === 403) throw new Error("n8n API key is missing permission for " + path.split("?")[0]);
      throw new Error("n8n API " + method + " " + path.split("?")[0] + " failed with HTTP " + res.status);
    }
    if (res.status === 204) return {};
    return res.json();
  }

  async function list(path) {
    const results = [];
    let cursor = "";
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const query = path + "?limit=250" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      const result = await api("GET", query);
      const entries = Array.isArray(result) ? result : result?.data;
      if (!Array.isArray(entries)) throw new Error("Unexpected n8n API list format for " + path);
      results.push(...entries);
      const next = result?.nextCursor;
      if (!next) return results;
      if (typeof next !== "string" || seen.has(next)) {
        throw new Error("Invalid n8n pagination cursor for " + path);
      }
      seen.add(next);
      cursor = next;
    }
    throw new Error("n8n API pagination limit exceeded for " + path);
  }

  // Project discovery is exclusively for the explicit project path.
  let project = null;
  if (workspace === "project") {
    const projects = await list("/projects");
    const matches = projects.filter(p => p.name === projectName && p.type !== "personal");
    if (matches.length > 1) throw new Error("Multiple n8n projects share this name; resolve ambiguity");
    project = matches[0] ?? null;
    if (action === "verify" && (!project || project.id !== projectId)) {
      throw new Error("Expected named n8n project was not found after import");
    }
  }

  // Check every existing record before any CLI import: n8n imports preserve
  // IDs and can overwrite credentials containing real provider secrets.
  const credentials = await list("/credentials");
  const workflows = await list("/workflows");
  const exactCredentials = credentialIds.filter(expected =>
    credentials.some(c => c.id === expected.id && c.name === expected.name));
  const exactInactiveWorkflows = workflowNames.filter(name =>
    workflows.some(w => w.name === name && w.active === false));
  if (action === "verify") {
    return {
      ok: true,
      workspace,
      ...(project ? { projectId: project.id } : {}),
      alreadySeeded: exactCredentials.length === credentialIds.length &&
        exactInactiveWorkflows.length === workflowNames.length,
    };
  }

  const conflictingCredentials = credentialIds.some(expected =>
    credentials.some(c => c.id === expected.id || c.name === expected.name));
  const conflictingWorkflows = workflowNames.some(name =>
    workflows.some(w => w.name === name));
  if (conflictingCredentials || conflictingWorkflows) {
    throw new Error("Existing ANCFZ credentials/workflows detected. Refusing duplicate or partial reseed to protect secrets and existing workflows; inspect and back up before making changes.");
  }

  if (workspace === "project" && !project) {
    const created = await api("POST", "/projects", { name: projectName });
    if (!created || typeof created.id !== "string") {
      throw new Error("n8n project creation returned no ID");
    }
    project = created;
  }
  return { ok: true, workspace, ...(project ? { projectId: project.id } : {}), alreadySeeded: false };
}

try {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  // Return sanitized messages only; never include credentials or request bodies.
  const known = String(error.message || "Workspace operation failed");
  const safe = known.replace(/(n8n_api_[A-Za-z0-9._-]+|Bearer [A-Za-z0-9._-]+)/g, "[redacted]");
  process.stdout.write(JSON.stringify({ ok: false, error: safe }) + "\n");
}
