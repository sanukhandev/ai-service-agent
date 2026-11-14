# Gemini Experimental Implementation Plan — Isolated Branch

**Status:** Planned only; this document does not represent implemented or tested functionality.

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

## 3. Target request flow

1. Browser submits customer message with the authorized server-side session binding to Node.
2. Node validates agent, customer/ticket ownership and AI session state against PostgreSQL; expired sessions cannot continue.
3. For an active session, Node atomically commits the customer message and extends the 60-minute idle deadline; a new session creates a fresh ticket/context.
4. Node loads current-session history, known facts, active intent and relevant source references from PostgreSQL or the validated Redis cache.
5. Node invokes the version-pinned Gemini model with Sara's published system instructions, allowed function definitions and the agent's approved File Search binding. **No web search tool**.
6. If Gemini requests application functions, Node validates tool name and arguments against the existing scoped registry and executes with trusted Node-issued agent/ticket scope. Avoid duplicates and limit rounds, response size and latency.
7. Node commits the assistant response, real citations, verified context changes, session provider state and ticket events; SSE delivers customer-visible updates.
8. Consequential operations require separate customer authorization, Node preflight, durable outbox and independently verified n8n/provider results.

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
| E8 Documentation | `docs/**`, `AGENTS.md` | Document Gemini-specific branch policy, API behavior, operational setup and final evaluation | No modifications to main |

**Concrete existing code constraints:** `turn-worker.ts` currently uses Foundry `previousResponseId` and only loads 12 recent messages if that cursor is absent; `turn-queue.ts` queries `ticket_model_sessions` with `provider='foundry'`, validates `resp_` response IDs, and writes `'foundry'` on completion. Replace these assumptions in the Gemini branch; otherwise recovery or session expiry will be incorrect. Existing `repositories/context.ts` already stores ticket facts and summaries, but those **must not** be automatically injected into a brand-new AI session.

Source-download handling must use exact authorized source mappings. Do not transfer Foundry's heuristic file matching or fabricated fallbacks into Gemini.

## 5. Delivery sequence and parallel work

- **Gate G0 (first):** Isolate Compose, secrets, databases, Redis, n8n and File Search stores; verify no shared operational resources. Confirm `main` SHA before/after writes.
- **Gate G1:** Live Gemini compatibility spike: persona instructions, real File Search citations, tool call/continuation, and relevant session metadata.
- **Gate G2 (contract freeze):** Provider-neutral turn/continuation, source reference, tool call and AI session-state contracts. Freeze session-expiration semantics and ownership.
- **Parallel after G2:** (A) model adapter/function execution, (B) File Search ingestion/source mapping, (C) session persistence/Redis, (D) experimental infrastructure/n8n integration. Separate worktrees and non-overlapping paths.
- **Integration G3:** Wire Gemini into the existing Node turn worker and chat API; one path only. Complete expiry-aware request admission, provider continuation and current-session-only recovery.
- **Gate G4:** Validate approved business operation authorization and n8n provider evidence.
- **Gate G5:** Run certification matrix and publish exact-head results, known limitations, logs and costs.
- **Gate G6:** Remove unused Foundry-only runtime dependencies **from the experimental branch**, update the experimental docs and retain the branch independently. Do not open a PR targeting main.

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

**Documentation-only status on creation:** No Gemini runtime, schema, session timer, Docker isolation or live integration has been implemented by creating this plan.
