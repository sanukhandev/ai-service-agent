# Microsoft Foundry POC — implementation and live acceptance tracker

**Baseline:** `main` commit `997555539e11cbe2be15406f69c07306aef6baae` (PR #23 merged 2026-11-14).  
**Scope:** Existing published Sara GPT-5.4 + native Foundry IQ, Node direct SDK/functions, ticket state, catalog, n8n, ANCFZ sample actions, private OCR and sandbox checkout.  
**Excluded:** Gemini experiment, Python gateway, LangGraph, pgvector, duplicate RAG service and POC admin UI.

## Source-of-truth precedence

1. `AGENTS.md`, `docs/02-architecture.md`, and the current runtime take precedence over older agent-centric architecture comparisons.
2. `docs/p3-foundry-runtime-and-publication.md` documents **P3 publication only**; P4–P7 added customer-controlled UI actions. It must not be interpreted as proof that an Azure agent has been republished.
3. `services/api/prompts/sara-service-employee.md` is the candidate P7 instruction source, **not** a declaration that the deployed version is updated.
4. A Foundry IQ retrieval result is not itself a validated source citation. A Node/n8n acknowledgement is not a verified external operation result.

## Current verification matrix

| Area | Code evidence in `main` | Still required for acceptance |
|---|---|---|
| P0 foundation | Nginx/Compose, isolated DB role, smoke jobs | Re-run local Compose/ingress on target host |
| P1 Foundry | Node `FoundryClient`, AzureCliCredential, bounded function continuation, IQ annotations parser | Authenticate target container, verify pinned version, genuine greeting/knowledge/citations |
| P2 persistence/chat | Ticket repositories, owner-scoped events, SSE/replay, Next chat | Refresh/restart/replay with live model and two separate identities |
| P3 catalog | Five allowlisted tools and versioned ANCFZ catalog, 21-intent optional test publication | Publish a **new** agent version with exactly these schemas and retained IQ, then prove live tool calls |
| P4 workflows | Node-authorized Salesforce lead and quotation orchestration, n8n adapters, verified PDFs | Validate real private n8n credentials, Salesforce sandbox and correlated external results |
| P5 identity/documents | Node OTP and upload flow, Azure Document Intelligence adapter, source-linked OCR, mock payment and invoice | Real sandbox OCR using **synthetic** IDs; review name mismatch, source provenance and refund denial |
| P6 integration | Customer action panel, consistent intent requirement gates, consolidated lifecycle | Browser end-to-end with no false success and no cross-agent/ticket access |
| P7 demonstration | Merged POC path, intent-action mapping, invoice recovery | Complete one actual end-to-end demonstration with trace and provider references |
| H1 hardening | Some offline checks/CI exist | Comprehensive security/perf/reliability certification remains separate from POC |

The PR #23 description records **six passing CI gates** on its reviewed head. This is useful offline evidence, but it is **not** a live Microsoft Foundry, Salesforce, Document Intelligence or merchant acceptance result. Do not copy its CI status onto a different SHA without rerunning.

## Execution sequence — preserve external boundaries

### Gate F1: Pin and validate the actual Foundry version

- Confirm the existing Sara agent project/name/version and native Foundry IQ connection in the authorized Azure project. Never modify the existing published version in place.
- Review the P7 candidate persona and export Node's exact **five** function schemas; compare function names, argument objects and definitions byte-for-byte with the planned Foundry publication.
- Create and intentionally publish a new Sara version that preserves IQ and web-access restrictions; activate in Node through a controlled version binding/seed. Do not switch existing tickets silently.
- Capture agent name/version, project (non-secret) ID, approved IQ source revision, observed function names, output tool call IDs and genuine citations.

Export:

```bash
npm ci
npm run build --workspace @ai-service-agent/api
node services/api/dist/foundry/export-tools.js > sara-p7-functions.json
```

Configure the existing API container's private Azure CLI volume without committing credentials:

```bash
docker compose build api
docker compose run --rm --no-deps --entrypoint az api login --use-device-code
docker compose run --rm --no-deps --entrypoint az api account show
docker compose run --rm --no-deps --entrypoint node api dist/foundry/smoke.js
```

The standalone smoke intentionally has **no application tool handlers**. It proves agent-read access, greeting and knowledge citations only; test five-function continuation through the real authorized Node ticket route.

### Gate F2: Conversation + knowledge + tools

Run against the **pinned live agent**, recording request IDs and source refs, for:

1. Greeting: answers without unnecessary IQ/tool calls.
2. ANCFZ background: actual approved IQ source citation.
3. Company types, available packages, indicative one-visa pricing, IT consultancy activities: source-dependent answers with correct qualifiers and versions.
4. Natural follow-up: no duplicate question when "one visa", "shared office", or "one shareholder" was already supplied.
5. Goal selection: `find_intents` and `select_ticket_intent` use **only the published ticket catalog**.
6. Corrected fact: `record_ticket_facts` retains current-customer-message provenance; the corrected value supersedes earlier context.
7. Requirement lookup and offering lookup: use Node authorization and pinned catalog revisions; no invented package price.
8. Unsupported function, unauthorized scope, malformed arguments, duplicate call ID, round/call budget exhaustion: fail safely.
9. IQ outage, missing citation, Foundry timeout/429 and uncertain response continuation: transparent typed failure, no fabricated success.
10. Refresh/restart: only accepted customer messages and a real `resp_` cursor, no model-provided ticket IDs or duplicate durable replies.

Use published test intents rather than guessing that all 21 are actionable or priced. Check at least one example phrase and one follow-up for **each** published intent and document the model/tool decisions. Measure failures separately for intent detection, IQ coverage, schema mismatch and response quality.

### Gate F3: Authorize actions, never auto-run on inferred intent

- Test direct customer consent denial, missing facts, wrong ticket owner, wrong agent, stale prices, repeated request IDs and simultaneous approval.
- Verify `create_lead` only completes when Salesforce supplies a correlated, independently validated lead ID through private n8n; webhook acknowledgement alone is insufficient.
- Verify `generate_quote` requires an authorized lead and effective price revision and stores a verified private PDF reference.
- Verify seven generic service-request actions create `awaiting_staff_review` records only. No invented bank/government/third-party completion.
- Verify the current UI's action panel correctly gates every catalog action; document that **fully declarative multi-step advancement is still incomplete**.

### Gate F4: Private documents, sandbox payment, invoice

- Use synthetic passport and Emirates ID only while running on localhost HTTP. Ensure the bytes and full document identifiers never enter Foundry prompts or n8n messages.
- Validate Azure Document Intelligence extraction and name agreement against controlled synthetic files; manually examine transliteration mismatches. OCR matching is not identity verification.
- Keep merchant payment disabled until real sandbox 2Checkout currency, credentials, one-shot order POST, authenticated GET correlation and refund statuses are demonstrated.
- Prove failure after pending/declined GET does not falsely downgrade a completed payment, and a verified refund revokes protected invoice access.
- Verify owner-only invoice PDF download, duplicate notification recovery and no charged/paid/issued outcome inferred from UI state.

### Gate F5: Hardening / deployment boundary

Before public usage, add TLS, secret rotation, managed identity, retention policy, high-coverage security tests, agent and ticket isolation checks, real browser E2E, provider callback replay/concurrency tests, measured p50/p95/p99, request/cost budgets and recovery exercises.

The HTTP localhost POC is **not** production-ready for real identity documents or customer PII. H1 does not become a release certificate merely because P0–P7 smoke gates pass.

## Evidence report template

For each gate record:
- Exact repository SHA and runtime/container image digest.
- Actual Foundry project, agent name + pinned version (omit secrets) and IQ binding revision.
- Exact command or UI steps actually performed; execution timestamp and environment.
- `PASS` / `FAIL` / `BLOCKED` / `NOT RUN` separately for offline, Docker, Azure, n8n and merchant checks.
- Request/turn/call IDs, ticket-scoped event cursor, actual source evidence and verified provider references, with sensitive values redacted.
- Required remediation, affected code owner and successful retest evidence.

**Release rule:** No live pass without real external evidence. No claim of complete Foundry acceptance based on green CI, a local prompt edit, an authenticated `az account show` or a plausible text answer.
