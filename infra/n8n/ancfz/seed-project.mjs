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
  if (!["prepare", "verify", "inspect"].includes(action) ||
      !["personal", "project"].includes(workspace) ||
      (workspace === "project" && !validName(projectName)) ||
      typeof apiKey !== "string" || apiKey.trim().length < 16 ||
      !Array.isArray(credentialIds) || credentialIds.length !== 4 ||
      !credentialIds.every(c => validId(c.id) && validName(c.name)) ||
      !Array.isArray(workflowNames) || workflowNames.length !== 5 ||
      !workflowNames.every(validName)) {
    throw new Error("Invalid workspace bootstrap parameters");
  }

  // On some n8n releases the local API is mounted under N8N_PATH,
  // while strip-prefix proxy deployments expose it at the container root.
  // Discover only through authenticated read-only calls; never retry writes.
  const normalizedPath = String(process.env.N8N_PATH || "/")
    .replace(/^\/+|\/+$/g, "");
  const apiRoots = [...new Set([
    "/api/v1",
    ...(normalizedPath ? ["/" + normalizedPath + "/api/v1"] : []),
  ])];
  let selectedApiRoot = null;

  class SeedApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function api(method, path, body) {
    const roots = selectedApiRoot ? [selectedApiRoot] : apiRoots;
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index];
      let res;
      try {
        res = await fetch(new URL(root + path, URL_BASE), {
          method,
          headers: {
            "X-N8N-API-KEY": apiKey.trim(),
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        if (error instanceof TypeError || error?.name === "TimeoutError" || error?.name === "AbortError") {
          throw new SeedApiError("API_UNAVAILABLE", "n8n internal API is unreachable or still starting");
        }
        throw new SeedApiError("API_REQUEST_FAILED", "n8n internal API request failed");
      }
      // Try the alternate configured public-API prefix only when the first
      // read-only probe returns 404. A 401/403 is never a startup delay.
      if (res.status === 404 && !selectedApiRoot && method === "GET" && index < roots.length - 1) continue;
      if (!res.ok) {
        const endpoint = path.split("?")[0];
        if ((res.status === 402 || res.status === 403) && endpoint === "/projects") {
          throw new SeedApiError("PROJECTS_FORBIDDEN", "n8n Projects API is unavailable; use --workspace=personal");
        }
        if (res.status === 401) {
          throw new SeedApiError("API_UNAUTHORIZED", "n8n API key invalid or expired for " + endpoint);
        }
        if (res.status === 403) {
          throw new SeedApiError("API_FORBIDDEN", "n8n API key lacks permission for " + endpoint);
        }
        if (res.status === 404 || res.status === 405) {
          throw new SeedApiError("API_ENDPOINT_UNAVAILABLE", "n8n API endpoint unavailable: " + endpoint +
            " (HTTP " + res.status + "; checked configured API path)");
        }
        if ([502, 503, 504].includes(res.status)) {
          throw new SeedApiError("API_UNAVAILABLE", "n8n API temporarily unavailable (HTTP " + res.status + ")");
        }
        throw new SeedApiError("API_HTTP_ERROR", "n8n API " + method + " " + endpoint + " returned HTTP " + res.status);
      }
      selectedApiRoot = root;
      if (res.status === 204) return {};
      try {
        return await res.json();
      } catch {
        throw new SeedApiError("API_INVALID_RESPONSE", "n8n API returned non-JSON response for " + path.split("?")[0]);
      }
    }
    throw new SeedApiError("API_ENDPOINT_UNAVAILABLE", "No supported n8n API path found");
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
  // Resolve the API base using workflow discovery before credential inspection.
  const workflows = await list("/workflows");
  const credentials = await list("/credentials");
  const exactCredentials = credentialIds.filter(expected =>
    credentials.some(c => c.id === expected.id && c.name === expected.name));
  const exactInactiveWorkflows = workflowNames.filter(name =>
    workflows.some(w => w.name === name && w.active === false));
  const conflictingCredentials = credentialIds.some(expected =>
    credentials.some(c =>
      (c.id === expected.id || c.name === expected.name) &&
      (c.id !== expected.id || c.name !== expected.name)));
  const conflictingWorkflows = workflowNames.some(name => {
    const sameName = workflows.filter(w => w.name === name);
    return sameName.some(w => w.active !== false) || sameName.length > 1;
  });
  const allPresent = exactCredentials.length === credentialIds.length &&
    exactInactiveWorkflows.length === workflowNames.length;
  const hasAny = credentialIds.some(expected =>
    credentials.some(c => c.id === expected.id || c.name === expected.name)) ||
    workflowNames.some(name => workflows.some(w => w.name === name));
  const status = conflictingCredentials || conflictingWorkflows ? "conflict" :
    allPresent ? "ready" : hasAny ? "partial" : "empty";

  if (action === "inspect") {
    return {
      ok: true, workspace, status,
      matchingCredentials: exactCredentials.length,
      matchingInactiveWorkflows: exactInactiveWorkflows.length,
      ...(project ? { projectId: project.id } : {}),
    };
  }
  if (action === "verify") {
    return {
      ok: true,
      workspace,
      ...(project ? { projectId: project.id } : {}),
      alreadySeeded: status === "ready",
    };
  }

  // A completed personal import is repeat-safe. Never reimport credentials:
  // n8n CLI imports can overwrite secrets when an ID already exists.
  if (status === "ready" && workspace === "personal") {
    return { ok: true, workspace, alreadySeeded: true };
  }
  if (status !== "empty") {
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
  const code = typeof error.code === "string" && /^[A-Z_]{3,48}$/.test(error.code)
    ? error.code : "SEED_PREFLIGHT_FAILED";
  process.stdout.write(JSON.stringify({ ok: false, code, error: safe }) + "\n");
}
