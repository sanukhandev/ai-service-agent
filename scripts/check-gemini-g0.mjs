#!/usr/bin/env node
// Offline G0 invariants only; does not call Gemini, Docker, GitHub or external services.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const types = read("packages/contracts/gemini-v1.ts");
const config = read("packages/contracts/tsconfig.gemini.json");
const compose = read("docker-compose.yml");
const instructions = read("AGENTS.md");
const plan = read("docs/gemini-experiment-implementation-plan.md");
assert.match(types, /GEMINI_CONTRACT_VERSION = "gemini-contract-v1"/);
assert.match(types, /GEMINI_ALLOWED_BUILTIN_TOOLS = \["file_search"\]/);
for (const forbidden of ["google_search", "url_context", "code_execution", "web_fetch"]) {
  assert(types.includes('"' + forbidden + '"'), "Forbidden tool must be recorded: " + forbidden);
}
for (const policy of [
  "externalWebSearch: false", "externalUrlContext: false",
  "usePretrainedBusinessFactsAsEvidence: false",
  "requireEvidenceForBusinessClaims: true", "failClosedOnMissingEvidence: true",
]) assert(types.includes(policy), "Missing policy invariant: " + policy);
assert.equal(JSON.parse(config).compilerOptions.noEmit, true);
assert.match(compose, /^name: ai-service-agent-gemini\s*$/m);
assert.match(compose, /127\.0\.0\.1:2000:80/);
assert(!compose.includes("127.0.0.1:80:80"), "Experiment must not claim main host port");
assert.match(compose, /ai-service-agent-gemini-postgres-data/);
assert.match(compose, /ai-service-agent-gemini-redis-data/);
assert.match(compose, /ai-service-agent-gemini-n8n-data/);
assert.match(instructions, /experiment\/gemini-file-search-poc/);
assert.match(plan, /P1 — Gemini model runtime/);
assert.match(plan, /P6 — Test harness/);
assert.match(plan, /GEMINI_FREEZE_SHA/);
console.log("Gemini G0 static contract/branch/resource checks PASS");
