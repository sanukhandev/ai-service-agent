#!/usr/bin/env node
/**
 * Runs INSIDE the private n8n Docker container.
 * Uses supported /api/v1 endpoints and the caller's owner API key.
 * A missing Projects entitlement MUST NOT silently fall back to personal space.
 * No credentials or API tokens are written to logs/disk.
 */
const URL_BASE = "http://127.0.0.1:5678";
const MAX_INPUT = 16384;

async function readInput() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk.toString("utf8");
    if (data.length > MAX_INPUT) throw new Error("Invalid bootstrap request size");
  }
  return JSON.parse(data);
}
const validName = s => typeof s === "string" && s.length >= 3 && s.length < 100;
const validId = s => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
async function main() {
  const { action, apiKey, projectName, projectId, credentialIds, workflowNames } = await readInput();
  if (!["prepare", "verify"].includes(action) || !validName(projectName) ||
      typeof apiKey !== "string" || apiKey.length < 16 ||
      !Array.isArray(credentialIds) || credentialIds.length !== 4 ||
      !credentialIds.every(c => validId(c.id) && validName(c.name)) ||
      !Array.isArray(workflowNames) || workflowNames.length !== 5 ||
      !workflowNames.every(validName)) throw new Error("Invalid project bootstrap parameters");

  async function api(method, path, body) {
    const res = await fetch(new URL("/api/v1" + path, URL_BASE), {
      method,
      headers: {
        "X-N8N-API-KEY": apiKey,
        "Accept": "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if ((res.status === 403 || res.status === 402) && path.startsWith("/projects")) {
        throw new Error("The n8n Projects API is not enabled or the owner key lacks project permissions. Register/activate Projects in n8n or use a licensed edition. No personal-project fallback.");
      }
      if (res.status === 401) throw new Error("n8n owner API key is invalid or expired");
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
      if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid n8n pagination cursor for " + path);
      seen.add(next);
      cursor = next;
    }
    throw new Error("n8n API pagination limit exceeded for " + path);
  }

  const projects = await list("/projects");
  let found = projects.filter(p => p.name === projectName && p.type !== "personal");
  if (found.length > 1) throw new Error("Multiple n8n projects share this name; operator must resolve ambiguity");
  let project = found[0] ?? null;
  if (action === "verify" && (!project || project.id !== projectId)) {
    throw new Error("Expected n8n project was not found after CLI import");
  }
  // Preflight global credential ID collisions even when target project is new.
  // Importing by matching ID can overwrite an existing credential!
  const credentials = await list("/credentials");
  const workflows = await list("/workflows");
  const matchCreds = credentialIds.filter(expected => credentials.some(c => c.id === expected.id && c.name === expected.name));
  const matchWorkflows = workflowNames.filter(name => workflows.some(w => w.name === name && w.active === false));
  const foreignCreds = credentialIds.filter(expected => credentials.some(c => c.id === expected.id && c.name !== expected.name));
  if (foreignCreds.length) throw new Error("Credential ID collision detected; import refused");

  if (action === "verify") {
    const success = matchCreds.length === credentialIds.length && matchWorkflows.length === workflowNames.length;
    return { ok: true, projectId: project.id, alreadySeeded: success };
  }

  if (matchCreds.length || matchWorkflows.length) {
    // The public list endpoints do not prove that matching assets belong to
    // this project. NEVER report success by matching names globally.
    // Re-importing credentials with the same IDs can overwrite secrets.
    throw new Error("Existing ANCFZ credentials/workflows detected. Refusing duplicate or partial reseed; verify their project ownership and back up the n8n DB before retry.");
  }
  if (!project) {
    const created = await api("POST", "/projects", { name: projectName });
    if (!created || typeof created.id !== "string") throw new Error("n8n project creation returned no ID");
    project = created;
  }
  return { ok: true, projectId: project.id, alreadySeeded: false };
}
try {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  // Never print HTTP request bodies, API keys, cookies or provider credentials.
  const known = String(error.message || "Project operation failed");
  const safe = known.replace(/(n8n_api_[A-Za-z0-9._-]+|Bearer [A-Za-z0-9._-]+)/g, "[redacted]");
  process.stdout.write(JSON.stringify({ ok: false, error: safe }) + "\n");
  // Controlled API failure is returned as structured JSON for the host orchestrator.
  // No exception details containing credentials are printed to stderr.
}
