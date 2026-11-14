# Gemini Experimental Implementation Plan — Isolated Branch

**Status:** Experimental infrastructure isolation is configured in Compose (dedicated project `ai-service-agent-gemini`, port `127.0.0.1:2000:80`, unique volumes/networks and n8n editor URL). **Docker startup and live runtime have not been tested; Gemini model and File Search integration are still planned.** This document is not evidence of a working Gemini agent.

**Repository:** `sanukhandev/ai-service-agent`  
**Branch:** `experiment/gemini-file-search-poc`  
**Branch base:** `4cd29c31f3df98dc6a6526faa0afddb1fa95f84a`  
**Foundry baseline:** `main` — independent and untouched by this experiment.

## 1. Objective and non-negotiable boundaries

Replace Microsoft Foundry Agent Service (GPT-5.4) and Foundry IQ **on this experimental branch only** with Gemini for model reasoning and Gemini File Search for approved knowledge. Preserve Next.js customer chat, Node Fastify orchestration and tool authorization, PostgreSQL ticket/message records, Redis ephemeral cache and n8n authorized business automation.

- **Never merge, cherry-pick or open a PR from the Gemini experiment into `main`.** Other experiments may integrate into this experimental branch only. Do not change main or its deployments. Enforce with GitHub branch/repository rules where possible; a written policy is not GitHub branch protection.
- Keep a single Node-owned conversation pathway. n8n is an authorized business action executor, **not** the conversational agent.
- Each application Agent controls a versioned persona, published instructions, private approved knowledge store, model binding, business-tool allowlist, intent catalog and offerings catalog.
- No Python gateway, LangGraph, pgvector, custom embedding service or new long-term AI memory system.
- The model may suggest actions; only Node checks authorization, customer approval, idempotency and independently verified provider outcomes.
- Use isolated Gemini credentials, Docker Compose project name, networks, PostgreSQL/Redis/n8n volumes, published host port and Google File Search stores. Never connect the experiment to Foundry's live database or volumes.
- Retain PostgreSQL as the authoritative system of record for tickets, messages, facts, tool outcomes and events. No business data should rely solely on Redis or Gemini storage.

## 2. Approved conversation memory policy (supersedes prior multi-day memory proposal)

**Conversation memory scope: one active customer AI session, 60-minute sliding inactivity timeout. Expired sessions start a fresh AI conversation. No automatic cross-session AI memory.**

| Case | Required behavior |
| --- | --- |
| New customer AI chat | Node issues a new opaque session ID and new ticket; start with fresh Gemini context |
| Active session | Carry relevant earlier messages, active intent, current facts, clarifications, tool results and knowledge citations **from this session only** |
| Activity timer | `expires_at = last_accepted_customer_message_at + 60 minutes` (server clock); accepting a customer message extends the timeout |
| Non-activity | Browser refresh, open tab, SSE, polling, keep-alive, background worker tasks and model replies do **not** extend inactivity |
| Customer message before expiry | Atomically verify session is active, accept message exactly once and extend expiration; serialize turns per session/ticket |
| Customer message at or after expiry | Reject continuation of old model context; create a new AI session and new ticket before processing the message, with explicit UI indication if needed |
| Browser refresh or short disconnect | Recover the **same unexpired session** using trusted session cookie/token and server-side session state |
| Node or Redis restart | Restore an **unexpired** session from its PostgreSQL messages and session metadata; no silent context loss |
| Gemini cursor unavailable or expired mid-session | Reconstruct context from **only the current unexpired session's** durable messages, facts and tool results; do not fail over to another ticket's data |
| End/explicit close or 60-minute idle expiry | Mark AI session closed/expired, invalidate provider continuation binding and evict Redis context; do not seed subsequent sessions from old summaries or facts |
| Old ticket/message records | Preserve in PostgreSQL under existing access controls and retention policy, even though they are not used as new-session AI memory |
| In-flight business operation on expiry | Preserve the authorized operation and result in the original ticket; do not silently cancel, duplicate, or carry authorization into a new session |

**Distinguish three identities:** authenticated customer/guest identity, business ticket identity, and **AI conversation session identity**. Closing an AI session does not itself revoke a valid login or delete historic tickets. Starting a fresh AI session does not reopen the previous conversation automatically.

**TTL enforcement:** PostgreSQL stores authoritative `session_id`, `agent_id`, `ticket_id`, `created_at`, `last_customer_activity_at`, `expires_at` and `status` (or an equivalent normalized record). Redis caches the active-session context under an agent- and session-scoped key with a matching 3,600-second sliding TTL, but Redis expiration does not alone decide whether a session is valid. Use database time in atomic validation/update; concurrent requests at the expiry boundary must not revive or mix expired sessions. Session identifiers must be server-issued and independently authorized, never trusted from Gemini arguments.

**Context window:** retain the complete transcript in PostgreSQL for the session, but only send as much to the model as fits the selected Gemini model's token budget. For unusually long active sessions, produce a **temporary session-only** summary and retain material facts, outstanding questions and relevant exact transcript excerpts. Never claim unlimited model context or exact reconstruction of private hidden reasoning. Delete/expire the cached summary when the AI session expires. Do not implement persistent cross-session semantic memory.

**Provider state:** while active, prefer Gemini's supported stateful interaction continuation and persist its current opaque reference with the **session**, provider and model. If continuity fails, rebuild from the current session's durable messages. Preserve provider-required tool continuation signatures/steps when a live pending tool call must resume; otherwise quarantine uncertain tool outcomes, rather than replaying side effects.

## 2A. Approved voice interface — Speech-to-Text → Gemini text → Text-to-Speech

**Decision:** Use a conventional STT/TTS pipeline for the POC. **Do not implement Gemini Live API, real-time audio-to-audio reasoning, or a separate voice-agent orchestration path.** Text chat and spoken chat must use the same Node-owned Gemini text-conversation worker, intent catalog, tool registry, knowledge search and 60-minute AI-session policy.

**Turn flow:**
1. Browser requests microphone consent, captures the customer's utterance and stops or detects an end of speech.
2. Speech-to-Text (STT) transcribes that utterance, returns text and an optional confidence/quality signal. Reject empty input; allow correction of critical ambiguous numbers, names and identifiers.
3. Browser submits the *transcript* through the existing authenticated Node message endpoint for the current unexpired AI session. The **same session** is used whether the input is typed or dictated. A newly accepted customer transcript counts as activity and slides the 60-minute deadline; microphone use, silence and unsubmitted STT activity do not.
4. Node persists the accepted message, runs the **same Gemini text model and agent instructions** as typed chat, and allows Gemini to request File Search and trusted Node business tools. Tool execution stays Node-authorized. The model returns a concise conversational answer, not a script.
5. Node persists the assistant answer and SSE event. The browser sends this answer to the configured TTS service and plays the resulting audio. Preserve the answer as normal visible chat text; TTS output is an alternate presentation, not a second model decision.
6. On cancellation or navigation, cancel pending microphone/STT/TTS work and stop playback without canceling already committed business operations. Do not allow overlapping response audio for the same customer turn.

**Voice-first prompt behavior:** Prefer short natural sentences; typically ask only one useful question at a time. Avoid reading out citations, Markdown, tool names, raw JSON, large lists, URLs and operational diagnostics. Business facts must still come from approved knowledge or Node-owned structured catalog data, even though citation metadata is **not displayed or read aloud**. Preserve provenance internally for diagnostics and grounding verification; never fabricate it. A customer may still ask for a longer explanation.

**Implementation boundaries:**
- Add a thin STT input and TTS output layer to the existing Next.js chat. The chosen STT/TTS providers should be replaceable and configured without credentials embedded in browser source. Prefer server-mediated credentials and short-lived authorized tokens where available.
- No changes to Node tool authorization, intent semantics, n8n business workflow rules or session-expiration invariants.
- STT/TTS audio need not be stored durably; persist the accepted transcript and assistant text as ordinary ticket messages. Handle audio only as transient data unless the customer explicitly opts into a separate retention feature.
- Do not send private knowledge source references, secrets or unnecessary PII to TTS. Review each speech provider's handling of customer audio and transcripts before using real customer information.
- Voice latency includes microphone capture/end-of-speech, transcription, Gemini reasoning/retrieval/tools, speech synthesis and playback. Instrument the stages separately; this pipeline does not guarantee instant full-duplex conversation or barge-in comparable to a real-time Live API.

**Acceptance:** Typed and spoken inputs yield equivalent authorized actions and session continuity; corrected transcripts are not accidentally treated as confirmed facts; Sara produces short speakable responses with no audible citations; refresh/restart/expiry behave identically for text and voice; mic-denied/STT/TTS unavailable cases fall back to text chat. Compare p50/p95 time from end of speech to first audible response and measure STT accuracy on ANCFZ terms, company names, numerals and visa counts.

## 3. Target request flow

1. Browser submits customer message with the authorized server-side session binding to Node.
2. Node validates agent, customer/ticket ownership and AI session state against PostgreSQL; expired sessions cannot continue.
3. For an active session, Node atomically commits the customer message and extends the 60-minute idle deadline; a new session creates a fresh ticket/context.
4. Node loads current-session history, known facts, active intent and relevant source references from PostgreSQL or the validated Redis cache.
5. Node invokes the version-pinned Gemini model with Sara's published system instructions, allowed function definitions and the agent's approved File Search binding. **No web search tool**.
6. If Gemini requests application functions, Node validates tool name and arguments against the existing scoped registry and executes with trusted Node-issued agent/ticket scope. Avoid duplicates and limit rounds, response size and latency.
7. Node commits the assistant response, real citations, verified context changes, session provider state and ticket events; SSE delivers customer-visible updates.
8. Consequential operations require separate customer authorization, Node preflight, durable outbox and independently verified n8n/provider results.


## 3A. Strict approved-source grounding policy — mandatory runtime behavior

**Security objective:** The model is permitted to reason and converse naturally, but it is **not** a trusted authority for any externally verifiable business fact. Every material business assertion must be supported by a verified, currently authorized source from this agent's approved knowledge version or an explicitly approved, source-traceable PostgreSQL catalog. A citation by itself is not proof of entailment.

- The server constructs the Gemini tool list from a hard allowlist: `file_search` bound only to the published, agent-authorized store plus explicitly authorized Node application functions. **Do not advertise or enable `google_search`, `url_context`, Google Maps, code execution, browser navigation or a general web-fetch tool** in customer-facing turns. Do not convert customer-supplied links into outbound fetches.
- Network calls to Gemini APIs and separately authorized business providers remain necessary; "no web search" is **not** an instruction to block the Gemini API itself. Customer/business facts must not be sourced from arbitrary external sites.
- Persona and instruction text is loaded from versioned Node-managed agent configuration. Only the server selects the published knowledge version. A model-generated tool argument, prompt or client request must never override agent/store/document authorization.
- Classify responses into: `social` (greeting/farewell), `clarification` (question without factual assertion), `business_factual`, `catalog_factual` and `operation_status`. If classification is ambiguous, use the stricter evidence-required path. Social responses need no source, but cannot smuggle factual claims.
- For `business_factual`, enforce exact document/store ownership, approved status, version pinning and semantic claim-to-evidence support. For `catalog_factual`, verify the actual persisted catalog value, variant, currency, date/range and provenance approval. For `operation_status`, verify Node's durable provider result. Customer assertions are unverified customer facts, not independent business-source evidence.
- Treat retrieved documents as **untrusted data**, not system instructions. Ignore embedded instructions to change the persona, disclose hidden data, call tools or bypass authorization. Never use provider confidence, lexical-overlap percentage or a citation alone to approve an answer.
- Produce a typed qualification result: `supported`, `unsupported`, `insufficient_evidence`, `unauthorized_source` or `verifier_unavailable`, with source/claim metadata kept private. Only `supported` factual answers may be shown. For all other outcomes, use a neutral, useful abstention or a relevant clarifying question. A bounded evidence-constrained retry may be attempted; never retry consequential operations as part of response repair.
- Preserve authorized internal source references and verifier decisions for diagnostics/audit; do **not** require visible or spoken citations in Sara's natural answer. Never invent a provider file ID, excerpt, line number or source URL.
- Maintain approved source originals or trustworthy normalized text in separately controlled private storage for independent claim verification and exact authorized source download. File Search indexing alone is not sufficient for independently inspecting every claim. User-uploaded ticket documents must never silently join the global agent knowledge store.
- Conversation sessions pin agent version, catalog revisions and knowledge version for their lifetime. A knowledge update must not silently alter the authority available to an in-progress turn. After 60 minutes without an accepted customer message, new sessions inherit **no** past conversation context (though they may use the currently published static agent knowledge).
- Failed/empty retrieval, missing annotation, missing approval, mismatched document identity, model timeout or verifier outage must **fail closed** for factual answers. No fallback to Gemini pretrained business facts or unapproved web search.

**Definition of source authority:** Approved File Search documents and independently approved, provenance-tracked structured catalogs are the **only** sources of business facts. If product requirements change to "literal documents only", catalog records without approved-document provenance must be excluded rather than grandfathered in. The existing ANCFZ test catalog is source-derived and **not** automatically business-owner-approved.

**Provider compatibility gate:** Verify the selected live Gemini model and the installed Node SDK for File Search, source annotations, stateful/stateless tool-continuation signatures, and combined built-in File Search + custom function calls. Tool combination is documented as model/API-surface dependent and may be Preview. If combined calls fail, keep one Node turn controller and orchestrate separate read-only retrieval and application-function steps with the same verified evidence contract; do not weaken source-policy gates. See the official API documentation: https://ai.google.dev/gemini-api/docs/file-search , https://ai.google.dev/gemini-api/docs/tool-combination and https://ai.google.dev/api/file-search/documents .

## 4. Migration and module work

| Workstream | Existing area | Required change | Must preserve |
| --- | --- | --- | --- |
| E0 Environment isolation | `docker-compose.yml`, `.env.example`, Nginx | Experimental Compose project, independent volumes/ports/keys, Gemini configuration | Foundry runtime on main |
| E1 Gemini feasibility spike | isolated TypeScript test | Verify greeting, File Search source/citations, tools and continuation for selected model and SDK | Do not replace existing worker before live spike passes |
| E2 Provider adapter | `services/api/src/foundry/**`, `services/api/src/agent/function-loop.ts` | Define provider-neutral model interface, add Gemini invocation and tool continuation, normalize citations/errors | One Node orchestrator, bounded authorized tool execution |
| E3 Knowledge | agent knowledge bindings, ingestion scripts | Agent-scoped Gemini File Search store, approved document ingestion/publication/revocation, original-file source mapping | Documents remain read-only to AI; ticket uploads stay private |
| E4 Conversation | `services/api/src/runtime/turn-worker.ts` | Enforce active AI session, pass session-scoped context, validate response/tool provenance | Natural conversation, intent/fact tools, no scripted stages |
| E5 Session persistence | `services/api/src/runtime/turn-queue.ts`, `services/api/src/repositories/**`, `infra/postgres/**` | Replace hard-coded `provider='foundry'` and `resp_` cursor constraints; add durable session metadata, expiry, provider-opaque continuation and recovery | Existing ticket/messages/events, RLS, atomic commits and idempotency |
| E6 Business operations | `infra/n8n/**`, action workers | Integrate Gemini proposals through existing Node-only authorization/dispatch | No direct model-to-n8n execution, verified outcomes |
| E7 Validation | tests, smoke scripts | Session lifecycle, knowledge, tool safety, grounded multi-turn and workflow tests | Accurate mock/local/live reporting |
| E9 Voice input/output | `apps/web/**`, optional speech API adapter | Add STT input, reuse normal Node Gemini text turn, TTS output, cancellation, text fallback; no Gemini Live | Same 60-minute session, authorized tools, citations remain internal |
| E8 Documentation | `docs/**`, `AGENTS.md` | Document Gemini-specific branch policy, API behavior, operational setup and final evaluation | No modifications to main |

**Concrete existing code constraints:** `turn-worker.ts` currently uses Foundry `previousResponseId` and only loads 12 recent messages if that cursor is absent; `turn-queue.ts` queries `ticket_model_sessions` with `provider='foundry'`, validates `resp_` response IDs, and writes `'foundry'` on completion. Replace these assumptions in the Gemini branch; otherwise recovery or session expiry will be incorrect. Existing `repositories/context.ts` already stores ticket facts and summaries, but those **must not** be automatically injected into a brand-new AI session.

Source-download handling must use exact authorized source mappings. Do not transfer Foundry's heuristic file matching or fabricated fallbacks into Gemini.


## 5. Executable work plan: shared contract, six parallel streams, single integration owner

### 5.1 Immutable branch and environment rules (apply to every task)

**Only permitted destination:** `experiment/gemini-file-search-poc` in `sanukhandev/ai-service-agent`. All child feature branches are **temporary implementation branches under the experiment**, not independent products. Every workstream MUST use an explicit repository ref, and every PR MUST target `experiment/gemini-file-search-poc`. No commit, PR, merge, cherry-pick, deployment or configuration change from this experiment may target `main`. The only cross-branch flow permitted is a separately reviewed, one-way `main` → experiment upstream sync coordinated by the integration owner.

**Before any implementation branch is created:**
1. Commit this plan and the shared contracts on the experimental branch. The integration owner records the **exact post-freeze experiment commit SHA** as `GEMINI_FREEZE_SHA` in the integration tracking record. Do not guess a SHA or create independent branches from a moving HEAD.
2. The integration owner publishes one contract version (e.g., `gemini-contract-v1`) covering all interfaces in §5.3. Each stream must acknowledge the exact freeze SHA, plan, API/SDK surface and owned paths.
3. Create **all six branches from that same `GEMINI_FREEZE_SHA`**, each in a separate worktree, and verify their common merge-base. Never base these branches on `main`, a stale mainline commit, or another workstream's head.
4. Treat `AGENTS.md`, this plan, `packages/contracts/**`, `services/api/src/runtime/turn-worker.ts`, `services/api/src/runtime/turn-queue.ts`, `services/api/src/index.ts`, `docker-compose.yml`, `infra/nginx/**`, `package.json` and lockfiles as **integration-owner only**. Workstreams propose changes to shared paths in a handoff note; they do not silently edit them. P2 alone owns its assigned migration/bootstrap paths.
5. Do not share `.env` files, API keys, local databases, Git worktrees, running containers or Google File Search stores between Foundry main and Gemini; use `ai-service-agent-gemini`, host `127.0.0.1:2000:80`, unique Compose volumes, separate credentials and separate store names.
6. All PRs must include: base SHA, changed paths, contracts consumed, commands actually run with results, live vs mocked evidence, API assumptions, unresolved blockers and an explicit statement that `main` was not modified. No blind auto-merging or rebase that silently drops another stream's changes.

**Suggested branch/worktree creation pattern (integration owner supplies the real freeze SHA):**

```powershell
git fetch origin experiment/gemini-file-search-poc
# Inspect / verify the recorded GEMINI_FREEZE_SHA first.
git worktree add ../gemini-p1 -b feat/gemini-model-adapter <GEMINI_FREEZE_SHA>
# Repeat with different worktree paths and the P2–P6 branch names below.
# For all PRs: base = experiment/gemini-file-search-poc, NEVER main.
```

**Safeguard:** GitHub presently may not enforce branch-direction rules server-side. The experimental `.github/GEMINI_BRANCH_POLICY.md` and rejection workflow are advisory until a trusted repository ruleset is enabled. Follow the hard operational restrictions above regardless of CI configuration.

### 5.2 Prerequisites and concurrency

- **G0 — contract freeze (serial, must complete first):** Confirm the experimental branch, architecture and trusted resource isolation; freeze the interfaces in §5.3 and record `GEMINI_FREEZE_SHA`. No implementation branch should independently invent a competing response schema, agent binding or session contract.
- **G1 — live Gemini compatibility spike (owned by P1, starts immediately after G0):** Confirm model ID, SDK/API surface, standalone File Search retrieval and genuine source annotations, function declaration/call/output roundtrip, continuation ID/signature handling and (if supported) combined File Search + functions. P1 must record real API request/response observations with redacted identifiers. A passing compile/mock is **not** G1 success.
- **Parallel after G0:** P2 persistence, P3 input validation and managed knowledge lifecycle, P4 offline verifier/policy, P5 mock n8n adaptation and P6 fixtures/test harness can start immediately. They work against frozen contracts and use fakes where the real provider is not ready. P1 production adapter and P3 provider-integration finalization depend on G1 observations. The G1 result must not cause independent teams to rewrite shared contracts unilaterally.
- **G2 — compatibility reconciliation (integration owner):** Either approve the combined-tool design or commit a revised versioned contract selecting Node-coordinated retrieval + function calls; then all streams update from the approved contract change only. Any breaking contract change requires an explicit, coordinated freeze update and revalidation, not a private branch workaround.

### 5.3 Frozen contract requirements (the authoritative interfaces)

Use TypeScript types under integration-owned `packages/contracts/**` after G0. Names below are **logical shapes** to freeze, not claims that source files already implement them.

| Contract | Mandatory fields / invariants | Producer → consumer |
| --- | --- | --- |
| `AgentRuntimeBinding` | trusted `agentId`, `agentVersionId`, provider=`gemini`, pinned model, system instructions/persona version, authorized Node tool names, active knowledge version and catalog revisions | P2 → P1/P3/P4/integrator |
| `KnowledgeStoreBinding` | `agentId`, `knowledgeVersionId`, exact provider store resource name, publication state, content digest, approval evidence, immutable publish timestamp | P2/P3 → P1/P4 |
| `ApprovedDocumentEvidence` | `agentId`, `knowledgeVersionId`, stable internal document/version IDs, original SHA-256, exact File Search document resource, cited source locator/excerpt when available, authorization and approval status | P3 → P4 |
| `ModelTurnRequest` | server-authorized session and ticket IDs, agent binding, current-session message/context, exact allowed store/tool list, bounded deadline, requestId | Integrator → P1 |
| `ModelTurnCandidate` | candidate text, model/provider ID, real source annotations, tool requests and call IDs, opaque continuation information, token usage and typed provider errors | P1 → integrator/P4 |
| `GroundingDecision` | decision enum, per-claim support or rejection reasons, trusted evidence IDs, verifier version, no fabricated source metadata | P4 → integrator |
| `AiSessionState` | agent/ticket/session identity, lifecycle status, createdAt, lastAcceptedCustomerMessageAt, expiresAt, pinned versions and opaque provider continuation | P2 → integrator |
| `AuthorizedActionOutcome` | ticket-scoped action key, consent/proposal reference, outbox idempotency, provider correlation, verified/uncertain/failed outcome | P5 → integrator |

**Invariant details:** All identifiers and scopes are Node-authorized, not model/browser supplied. Knowledge and catalog versions are pinned for an active session. Claim evidence must resolve to approved, still-authorized source content. AI memory is 60-minute sliding inactivity from the **last accepted customer message**, not a general browser activity clock. Outbound business actions are outside the LLM response-verification retry loop.

**Shared error vocabulary:** `MODEL_UNAVAILABLE`, `FILE_SEARCH_UNAVAILABLE`, `NO_APPROVED_EVIDENCE`, `UNAUTHORIZED_SOURCE`, `UNSUPPORTED_CLAIM`, `CATALOG_PROVENANCE_UNVERIFIED`, `TOOL_NOT_AUTHORIZED`, `SESSION_EXPIRED`, `OPERATION_OUTCOME_UNCERTAIN`. Teams may add internal diagnostics without inventing success states.

### 5.4 P1 — Gemini model runtime and compatibility (critical path)

- **Branch:** `feat/gemini-model-adapter`
- **Owned paths:** `services/api/src/gemini/**` and its co-located P1 tests. No edits to the shared function loop or current worker; propose a minimal integration diff to the owner.
- **Implementation:** Isolated SDK client; injected approved persona; exact agent-pinned File Search tool; authorized function declaration generation; validated tool request/response mapping; bounded call rounds; provider errors, timeouts, cancellation, usage; typed citation and continuation normalization. Omit all Google Search/URL Context/Maps/browser/code tools.
- **G1 spike:** Live supported question from an approved single-document store, missing-knowledge question, real source annotations, custom read function request and output, same-session continuation, and explicit combined-tool capability probe. Preserve required Gemini interaction signatures/IDs. If combined use fails, recommend two-step Node orchestration without adding another runtime.
- **Tests:** malformed tool call, duplicate call ID, excessive args/rounds, forbidden tool request, empty citation, no-store state, invalid continuation, timeout and provider 429/5xx. Do not auto-retry a potentially completed side effect.
- **Done:** Fake/unit tests pass **and** G1 evidence records a real compatible model/API path; otherwise P1 is marked `BLOCKED_LIVE_COMPATIBILITY`, not complete.

### 5.5 P2 — Database, sessions, provider bindings and seeds (critical path)

- **Branch:** `feat/gemini-persistence`
- **Owned paths:** `infra/postgres/**`, `infra/bootstrap/**`, `infra/catalog/seed-ancfz-test.sql`, `scripts/publish-ancfz-test-catalog.sh`, designated new files under `services/api/src/repositories/**` and related P2 tests. Shared runtime files remain integration-owned.
- **Implementation:** Reuse the existing `001–008` migration semantics and agent-scoped RLS. Prefer **new forward migrations** for Gemini provider binding, knowledge versions/documents/evidence, and `ai_conversation_sessions`; do not rewrite any migration whose checksum has been recorded. Rework the experimental migration runner to remove mandatory Foundry environment variables, replace Foundry-only Sara seed with versioned Gemini Sara configuration, and remove provider-specific `resp_` cursor assumptions only through an approved repository/runtime contract.
- **Catalog:** Retain source-derived ANCFZ test catalog (21 intents, 97 offerings, 55 priced variants) with clearly `test`/unapproved provenance. Separate catalog publication from agent-version changes; the old test publisher must not replace persona/tool permissions when updating catalog revisions. No arbitrary catalog promotion to approved authority.
- **Sessions:** PostgreSQL authoritative session lifecycle with atomic admission/expiry and exactly one active context; Redis only cached session context. Avoid conflating `guest_sessions` (authentication) with AI sessions. Expiry does not delete historical tickets or cancel already authorized operations.
- **Tests:** migration fresh and repeat runs, checksum checks, no Foundry variables, publication idempotency/version pinning, agent and user RLS, source provenance denial, concurrency at 60-minute boundary, restart/Redis loss, restricted database role and no data reset.
- **Done:** Clean Gemini database bootstraps and reruns safely, Sara publishes without Foundry, security constraints hold and session tests pass. Docker-enabled integration is mandatory before P2 certification.

### 5.6 P3 — File Search ingestion and knowledge publication (critical path)

- **Branch:** `feat/gemini-file-search-ingestion`
- **Owned paths:** `services/api/src/knowledge/**`, dedicated `scripts/ingest-agent-knowledge.*` / `scripts/verify-agent-knowledge.*` and P3 tests. Database schema ownership remains P2; P3 consumes frozen repository interfaces.
- **Implementation:** Reuse file validation, SHA-256, archive-bomb/path checks, private staging, human approval, safe extraction and optional OCR *concepts* from the older ingestion utility; do not copy the Python worker, custom chunker, vector indexes, embedding pipeline or legacy tenant storage into this Node runtime.
- **Managed stores:** One agent-specific File Search store **per knowledge version**. Import only reviewed sources, add exact provider IDs and source metadata, poll import operation and document states, require active/indexed status, exercise known-positive and known-negative retrieval, then publish binding atomically. No silent changes to in-progress sessions.
- **Safety:** Reject unsupported format/oversize, duplicates, symlinks/traversal, ZIP bombs and unapproved sources. Log hashes and stable internal IDs. Do not leak real customer uploads into agent-wide knowledge. Keep trusted originals/extracted text for independent verification. Revoke/retire only after pinned-session and retention checks.
- **Tests:** duplicate import no-op, changed hash new version, partial failure recovery, stale/failed document state, wrong agent/store, unauthorized source download, version publication/rollback, retrieval quality and provider citation mapping.
- **Done:** A live test-only Sara store supports successful retrieval with exact approved citation mapping. Provider API errors and incomplete ingestion never mark a version published.

### 5.7 P4 — Strict response qualification and evidence policy (critical path)

- **Branch:** `feat/gemini-grounding-verifier`
- **Owned paths:** `services/api/src/grounding/**` and P4 tests. The integration owner invokes it from the response publication path.
- **Implementation:** Server-owned tool/source allowlist; social/clarification/factual/operation classification; per-material-claim extraction; exact agent/store/document approval; evidence-claim support; deterministic number/currency/term checks; catalog provenance; provider outcome checks; prompt-injection-resistant treatment of retrieved source text.
- **Failures:** No citation, stale source, conflicting price, weak semantic support, unapproved document, cross-agent citation, unavailable verifier or provider timeout yields a typed `unsupported`/`insufficient_evidence`/`unauthorized_source` decision. Only one bounded, evidence-constrained rewrite attempt for factual language; it must not replay actions.
- **Tests:** paraphrases accepted when entailed, unsupported details rejected, source citation spoofing, customer-input injection, adversarial document instructions, fabricated provider reference, source revocation, partial claim support and precision/recall against a golden evaluation set. **No lexical-overlap rejection threshold.**
- **Done:** Verifier demonstrably accepts grounded paraphrases without accepting unsupported business claims. Report both false-positive rejection and unsupported-answer escape rates. A mock-model pass is not an end-to-end quality certification.

### 5.8 P5 — Existing n8n workflow bridge and operation verification

- **Branch:** `feat/gemini-n8n-adapter`
- **Owned paths:** new experiment-specific n8n adapter tests/fixtures and non-conflicting integration modules; propose shared runtime edits to the integration owner. Do not independently mutate core `infra/n8n/ancfz/**` templates during parallel development unless explicitly assigned.
- **Implementation:** Reuse existing n8n seed/workflow assets already integrated from upstream. Node alone accepts action proposals, preflights authorization, checks consent and prerequisites, persists idempotent outbox operations, dispatches private webhooks and correlates verified provider results. Gemini never executes n8n URLs, Salesforce or payment APIs directly.
- **Safety:** Local mock OTP is test-only and inactive until intentionally enabled; SMTP and mock OTP must never share an active webhook. Provider timeout is uncertain, not a completed action; no blind retry or fabricated invoice, payment or CRM success.
- **Tests:** unauthorized action, missing consent, duplicate call/replay, n8n unavailable, provider timeout, wrong ticket/agent ID, provider acknowledgment without verifiable success, internal-only webhook access and mock-only smoke.
- **Done:** Mock/private integration proves correct authorization and outcomes; mark third-party provider E2E pending until actual sandbox evidence exists.

### 5.9 P6 — Test harness, adversarial fixtures and operator documentation

- **Branch:** `test/gemini-certification`
- **Owned paths:** new `tests/gemini/**`, dedicated `scripts/check-gemini-*.mjs` fixtures and P6-owned test/operator documentation. Do not modify shared runtime or other streams' test files.
- **Implementation:** Build source-backed positive/negative evaluation questions, cross-agent and cross-session leakage fixtures, document prompt-injection cases, tool safety and authorization tests, migration/startup isolation checks, 60-minute boundary matrix, error handling and trace/report schema. Distinguish mock, local Docker and live Gemini/provider executions.
- **Required assertions:** Web-search and URL-context tools absent; greeting allowed without citation; unsupported facts never shipped; each factual claim has authorized evidence; no cross-agent source exposure; no unauthorized operation; no reused expired AI session; no duplicated external action; exact account/ticket authorization.
- **Done:** Reproducible scripts, deterministic fixtures, CI job configuration proposal and baseline report templates are ready. Actual final pass/fail requires integrated exact-head runs.

### 5.10 Integration-owner-only sequence (after independent streams)

1. Confirm each workstream was based on `GEMINI_FREEZE_SHA`, used only owned files, and has documented unit results; check open PR base is **the experiment branch**, never `main`.
2. Land P2 schema/seed first; migrate a fresh **experimental** PostgreSQL volume, verify least-privilege role, catalog and session API. Do not connect to main's data.
3. Land P3 ingestion and known-approved source mappings; confirm a real active File Search document/store and reversible publication.
4. Land P1 Gemini client with G1 evidence; connect the Node-owned function registry and provider continuation without exposing web tools.
5. Land P4 verifier; the integrator must insert its **fail-closed decision before persisting and emitting assistant factual messages**, including streaming/SSE paths. No preliminary unsupported answer may leak through streaming.
6. Land P5 n8n bridge; ensure Node authorization and outbox boundaries remain independent from candidate-answer retries.
7. Land P6 test harness; integrate routes/UI, `turn-worker.ts`, `turn-queue.ts`, contracts, dependency lockfiles, Compose, README and CI in a **single integration worktree**.
8. Run full clean build, typecheck, lint, unit/integration/migration checks, live known-good/bad retrieval, action authorization and 60-minute session tests at the **exact integrated commit**; collect measured results and explain any blockers.
9. Remove obsolete Foundry-only dependencies and instructions **on the experimental branch only**, preserving the established one-way branch policy. Never raise an experiment-to-`main` PR.

Each merge must be reviewed for schema/contracts, duplicate code paths and drift. A partially complete workstream may land only if its feature remains disabled, its gaps are documented and it does not weaken grounding/security checks.

### 5.11 Acceptance matrix and stop conditions

| Gate | Required proof | Status at planning time |
| --- | --- | --- |
| G0 | Shared types/policy frozen, explicit base SHA, only experiment branch/worktrees, no shared credentials/volumes | **Pending freeze**; isolation Compose files configured, live startup not verified |
| G1 | Live model + File Search annotation + function continuation spike, real supported model/API | **Pending** |
| G2 | Approved compatibility/contract decision, no competing tool-loop architectures | **Pending** |
| G3 | All streams integrated; model responses go through verifier before persistence or SSE | **Pending** |
| G4 | Authorized n8n actions, idempotency and verified provider outcomes | **Pending** |
| G5 | Full security/quality suite at exact integrated SHA and explicit measured results | **Pending** |
| G6 | Experimental runtime uses Gemini only; Foundry-only code retired within experiment; main unchanged | **Pending** |

**Hard stop / fail closed:** No published File Search store; no approved source for a factual claim; unauthorized document/cross-agent reference; verifier unavailable; tool call outside allowlist; unsupported model/tool combination without the approved two-step fallback; or an unverified consequential provider outcome. These are blockers, **not** reasons to enable browsing, bypass checks, silently change providers, mix agents or replay business side effects.

**Certification target (not a reported result):** Zero known unsupported material business facts escaping the verifier, zero cross-agent/expired-session leakage, zero unauthorized workflow actions and zero duplicate side effects in the evaluated corpus. Report total cases, grounding acceptance/rejection rates, false rejections, latency, token usage and integration/provider costs. A "100%" claim requires its exact test corpus and evidence.

**Single path of truth:** This file is the authoritative Gemini experimental plan. `docs/10-implementation-plan.md` and older Foundry docs are historical context on this branch. If a workstream discovers an architecture conflict, propose a versioned amendment **here first**, then update contracts and dependent teams; do not implement divergent behavior and justify it later.


## 6. Session continuity and safety test matrix (mandatory)

1. Multiple turns within 60 minutes: remember supplied fields, customer corrections, active goal and earlier questions; avoid redundant questions.
2. Browser refresh/reconnect within timeout: same AI session and conversational context.
3. Customer activity at 59 minutes: expiration slides 60 minutes from the newly accepted message.
4. Idle at exactly 60 minutes: new customer message starts new AI session/ticket and **no old conversation facts or summaries** are supplied to Gemini.
5. SSE/polling/heartbeat/model-only activity: does not extend the inactivity deadline.
6. Redis flushed or Node restarted before expiry: current AI session restored from authorized PostgreSQL data.
7. Redis flushed or Node restarted after expiry: new AI session, no resurrection of expired context.
8. Gemini interaction expired/unavailable while our session is still valid: reconstruct from **same-session** PostgreSQL history; never inject another ticket's history.
9. Extremely long active session: transcript retained durably; bounded current-session summary/facts retain all important business information relevant to next reply.
10. Concurrent messages around the timeout: exactly one ordered state transition, no old/new session mixing, no duplicate messages/actions.
11. Multi-agent and cross-user isolation: no cross-session, cross-ticket or cross-agent fact, source, prompt or tool data leakage.
12. Expiry with in-flight authorized n8n action: old ticket records independent verified result, new conversation gets no implicit authorization or outcome.
13. Unauthorized source download and fabricated citation tests: denied/unresolved instead of returning unrelated content.
14. Provider errors/tool timeouts: typed outcome, bounded retry/reconciliation and no claims of successful operations without evidence.

15. Voice/STT/TTS: typed-vs-spoken parity, one shared 60-minute AI session, clear short TTS output, no spoken citations, invalid transcript handling, denied mic / provider failure fallback, stage latency measurements.

**Certification target:** 100% preservation of committed ticket records, accepted current-session messages, validated customer facts within the active session and independently verified business outcomes; zero cross-session context leakage, unauthorized tool calls and duplicated side effects. Evaluate natural conversation, intent/tool choice, document grounding, citation correctness, latency and cost separately. Record measured results; targets do not equal achieved passes.

## 7. Explicit non-goals

- No automatic memory or history retrieval from tickets in **previously expired sessions**.
- No requirement for AI to remember customers for days.
- No deleting business tickets or transcripts merely because AI session memory expires.
- No dependence on Redis as authoritative storage; no separate long-term vector memory.
- No reimplementing the complete Foundry IQ stack unless File Search fails measured quality gates.
- No branch merge, cherry-pick, or PR into `main`.

## 8. Definition of done

A customer can chat naturally with Sara, retrieve genuinely cited ANCFZ knowledge, use authorized intent/offerings tools and trigger separately approved n8n workflows. Within an active AI session, context survives browser refresh, Node restart, Redis eviction and provider cursor failure. After **60 minutes without an accepted customer message**, the next message begins a **fresh AI conversation** with no inherited facts or summaries. Historical tickets remain safely persisted and accessible through normal ticket authorization. Independent environments and branch separation are verified.

**Current execution boundary:** Docker Compose resource and port separation, environment examples, Nginx forwarded-host handling, smoke-script target and seeding-script project pinning are committed to the experimental branch. The Docker engine was unavailable for a live launch, so container startup, migration, n8n provisioning and end-to-end behavior are unverified. Gemini runtime, knowledge ingestion, session timer and live integrations remain unimplemented.
