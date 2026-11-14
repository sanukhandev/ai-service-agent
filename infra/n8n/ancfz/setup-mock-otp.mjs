#!/usr/bin/env node
/**
 * Private, local-only mock OTP add-on setup helper. Never expose via an HTTP route.
 * The owner API key arrives over stdin, never argv, environment or logs.
 * Uses n8n's public Data Tables and Workflows APIs; no SQLite modifications.
 */
const TABLE_NAME = "ANCFZ_POC_OTPS";
const WORKFLOWS = [
  "ANCFZ | MOCK OTP Data Table Delivery (LOCAL ONLY)",
  "ANCFZ | MOCK OTP Expiry Cleanup (LOCAL ONLY)",
];
const COLUMNS = [
  { name: "ticketId", type: "string" },
  { name: "emailMasked", type: "string" },
  { name: "otp", type: "string" },
  { name: "issuedAt", type: "date" },
  { name: "expiresAt", type: "date" },
  { name: "status", type: "string" },
];

async function readInput() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk.toString("utf8");
    if (body.length > 8192) throw Error("Invalid setup input size");
  }
  return JSON.parse(body);
}
class SetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new SetupError(code, message); };
function apiClient(apiKey) {
  const base = "http://127.0.0.1:5678";
  const prefix = String(process.env.N8N_PATH || "/").replace(/^\/+|\/+$/g, "");
  const roots = [...new Set(["/api/v1", ...(prefix ? ["/" + prefix + "/api/v1"] : [])])];
  let selected = null;
  return async function api(method, path, data) {
    const possible = selected ? [selected] : roots;
    for (let i = 0; i < possible.length; i++) {
      const root = possible[i];
      let res;
      try {
        res = await fetch(new URL(root + path, base), {
          method,
          headers: {
            "X-N8N-API-KEY": apiKey,
            "Accept": "application/json",
            ...(data ? { "Content-Type": "application/json" } : {}),
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        fail("API_UNAVAILABLE", "n8n internal API unavailable");
      }
      if (res.status === 404 && method === "GET" && !selected && i < possible.length - 1) continue;
      if (!res.ok) {
        if (res.status === 401) fail("API_UNAUTHORIZED", "n8n owner API key invalid or expired");
        if (res.status === 403) fail("API_FORBIDDEN", "n8n API key lacks data-table or workflow permissions");
        if (res.status === 404 || res.status === 405) fail("API_ENDPOINT_UNAVAILABLE", "n8n public API endpoint unavailable for " + path.split("?")[0]);
        fail("API_ERROR", "n8n " + method + " " + path.split("?")[0] + " failed, HTTP " + res.status);
      }
      selected = root;
      if (res.status === 204) return {};
      try { return await res.json(); }
      catch { fail("INVALID_API_RESPONSE", "n8n returned invalid API JSON"); }
    }
    fail("API_ENDPOINT_UNAVAILABLE", "n8n public API prefix not found");
  };
}
async function listAll(api, pathname) {
  const results = [];
  let cursor = null;
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const query = pathname + "?limit=250" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const response = await api("GET", query);
    const rows = Array.isArray(response) ? response : response?.data;
    if (!Array.isArray(rows)) fail("INVALID_API_RESPONSE", "Unexpected n8n list result");
    results.push(...rows);
    cursor = response?.nextCursor || null;
    if (!cursor) return results;
    if (typeof cursor !== "string" || seen.has(cursor)) fail("INVALID_API_RESPONSE", "Invalid n8n API cursor");
    seen.add(cursor);
  }
  fail("INVALID_API_RESPONSE", "n8n API list exceeded pagination bound");
}
async function main() {
  if (process.env.APP_ENV !== "development") fail("DISABLED", "Mock OTP add-on is prohibited in production");
  const input = await readInput();
  if (!input || !["inspect", "prepare", "verify"].includes(input.action) ||
      typeof input.apiKey !== "string" || input.apiKey.trim().length < 16) {
    fail("INVALID_INPUT", "Invalid mock OTP setup request");
  }
  const api = apiClient(input.apiKey.trim());
  const [tables, workflows] = await Promise.all([
    listAll(api, "/data-tables"), listAll(api, "/workflows"),
  ]);
  // Same webhook path is used by the original SMTP delivery workflow.
  // Two active handlers would make OTP delivery ambiguous.
  if (workflows.some(w => w.name === "ANCFZ | Deliver Payment OTP (Node Generated)" && w.active === true)) {
    fail("SMTP_WORKFLOW_ACTIVE", "Deactivate the original SMTP OTP workflow before installing the mock alternative");
  }
  const matches = tables.filter(t => t.name === TABLE_NAME);
  if (matches.length > 1) fail("TABLE_CONFLICT", "Multiple mock OTP tables share the expected name");
  let table = matches[0] || null;
  if (table) {
    if (!Array.isArray(table.columns)) {
      table = await api("GET", "/data-tables/" + encodeURIComponent(table.id));
    }
    const existing = new Map((table.columns || []).map(c => [c.name, c.type]));
    if (COLUMNS.some(c => existing.get(c.name) !== c.type)) {
      fail("TABLE_SCHEMA_MISMATCH", "Existing ANCFZ_POC_OTPS has an incompatible column schema. No data was modified");
    }
  }
  const counts = WORKFLOWS.map(name => workflows.filter(w => w.name === name));
  if (counts.some(rows => rows.length > 1 || (rows.length === 1 && rows[0].active !== false))) {
    fail("WORKFLOW_CONFLICT", "Mock OTP workflow name already active or duplicated; no changes made");
  }
  const missing = WORKFLOWS.filter((name, idx) => counts[idx].length === 0);
  if (input.action === "prepare" && !table) {
    const created = await api("POST", "/data-tables", { name: TABLE_NAME, columns: COLUMNS });
    if (!created?.id || created.name !== TABLE_NAME) fail("TABLE_CREATE_UNCERTAIN", "n8n Data Table create outcome uncertain; inspect before retrying");
    table = created;
  }
  const result = {
    ok: true,
    table: TABLE_NAME,
    tableExists: Boolean(table),
    workflowsInstalled: WORKFLOWS.length - missing.length,
    workflowsTotal: WORKFLOWS.length,
    missingWorkflows: missing,
    ...(input.action === "verify" ? { complete: Boolean(table) && missing.length === 0 } : {}),
  };
  return result;
}
try {
  process.stdout.write(JSON.stringify(await main()) + "\n");
} catch (error) {
  const known = String(error?.message || "Mock OTP setup failed");
  const safe = known.replace(/Bearer\s+\S+|n8n_api_[A-Za-z0-9._-]+/gi, "[redacted]");
  process.stdout.write(JSON.stringify({
    ok: false,
    code: typeof error?.code === "string" ? error.code : "SETUP_FAILED",
    error: safe,
  }) + "\n");
}
