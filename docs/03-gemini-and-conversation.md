# Gemini model runtime, File Search and Node function continuation

## Active path

`Next.js → Fastify ticket admission → PostgreSQL accepted customer message → TurnQueue → GeminiTurnWorker → GeminiModelAdapter → Node grounding verifier → durable response/event → SSE`.

The one active worker is `services/api/src/runtime/gemini-worker.ts`; it does not invoke a secondary model gateway. The adapter in `services/api/src/gemini/adapter.ts` uses the Gemini Developer API via `@google/genai`. Runtime model, persona, permissions and File Search store are selected from Node-published agent/session bindings, not from customer content. Sara's versioned persona text is defined in `infra/bootstrap/sara-persona.sql`; it is published to PostgreSQL on fresh bootstrap. Existing deployed Sara versions can be explicitly upgraded with `GEMINI_SARA_PUBLISH_PERSONA=YES` on the isolated migration job, which creates a new immutable version for future tickets while active sessions stay pinned.

The existing Sara example is pinned in PostgreSQL by operator-controlled publication. Local `.env` must supply `GEMINI_API_KEY` and a private 32-byte hex `GEMINI_STATE_ENCRYPTION_KEY` before the worker can start. Never log either secret.

## Tool separation

**Knowledge:** the only model builtin is `file_search`, using the precisely published and authorized store for the active agent/session. No Google Search, URL Context, browser tool or arbitrary web fallback. Indexing, revocation, approval metadata and retained source text belong to `services/api/src/knowledge/` and `services/api/src/repositories/gemini-knowledge.ts`.

**Business tools:** Node publishes a bounded allowlist from the registry (`find_intents`, `select_ticket_intent`, `get_intent_requirements`, `record_ticket_facts`, `get_offerings`, `preflight_operation`, `propose_operation`). Each request carries a trusted server-derived agent/ticket/message/catalog scope. The model cannot select another agent, invoke a webhook, write to CRM or grant its own tool permissions.

The worker currently separates function passes and knowledge-only File Search passes. Do not assume combined File Search and function declarations are compatible until G1 live evidence confirms this provider capability.

## Turn processing

1. Fastify validates ticket ownership and accepts customer messages durably before enqueueing a model turn.
2. The worker loads the active 60-minute AI session, published Gemini binding, catalog revisions and bounded recent conversation history.
3. It invokes Gemini with an allowlisted function schema set, validates returned function calls and executes permitted Node handlers with trusted scope.
4. Pending Gemini provider continuation is preserved in encrypted PostgreSQL storage scoped to agent/session. Tool call rounds and output sizes are bounded.
5. The candidate factual answer is independently qualified against approved source documents and authorized catalog evidence.
6. If evidence fails and a File Search store is published, the worker may attempt a knowledge-only generation and reverify; it does **not** stream the initial unverified answer.
7. Only a supported answer or safe clarification is atomically committed with its audit and SSE event. A provider assertion or citation without verified document identity is insufficient.

Session expiry is based on the last accepted customer message and enforced by PostgreSQL. Expired sessions start new AI conversations without carrying old model context; historical ticket data remains under normal authorization.

## Evidence and publication policy

Document identity must resolve to an exact approved source/version using the provider's document resource or trusted custom metadata tuple plus PostgreSQL provenance checks. Source title, retrieved excerpt or File Search store name alone do not authorize a factual assertion. Revoked documents and unapproved pricing must fail closed. The verifier executes before any assistant message persistence or SSE publication. Customer uploads remain separate private ticket artifacts.

## Validation

- `.github/workflows/gemini-p7-integration.yml`: TypeScript, API, knowledge/grounding tests, fake-model worker/database integration, Docker image, Next.js and G0 invariants.
- `scripts/gemini-g1-live.mjs`: explicitly billable synthetic store/model/function/citation probe requiring private credentials; see [P7 status](gemini-p7-status.md).
- `tests/gemini/`: offline policy harness plus separate pending local/live certification against real isolated providers.

**Status:** implementation/offline CI integrated; live Google citation compatibility, approved Sara corpus testing and real n8n UAT are not yet certified.
