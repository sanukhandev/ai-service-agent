# Gemini P1 — model adapter (G0 `gemini-contract-v1`)

## Selected API surface

Official Google Node SDK `@google/genai`, `models.generateContent` (Gemini Developer API), Node-controlled function execution. API calls and model/store selection are restricted to the trusted G0 `ModelTurnRequest`. No Foundry/HTTP/web fallback is present. This adapter returns candidate responses **only**; P4 must verify factual claims before persistence or streaming.

`runTurn(request, { phase: "knowledge" | "functions" | "combined", signal? })` chooses an explicit phase. **Default** is `knowledge` when authorized File Search is present, otherwise `functions`. `knowledge` advertises only the approved File Search store; `functions` advertises only authorized Node registry declarations. This is the safe, sequential Node-controlled tool separation. `combined` is **disabled by default**, even on models claiming support, and requires `combinedToolsLiveVerified: true` after a real G1 test for the pinned model and API surface. The adapter does not automatically decide when a separate function phase should run; the Node integration owner orchestrates phases.

The adapter does not execute business functions. When Gemini requests them, it returns typed `ModelFunctionCall`s plus a `pendingToolStateRef` from the injected `PendingFunctionStore`. Node executes only through its own authorization/consent/registry. Then Node passes the validated JSON results into `continueWithFunctionOutputs(...)`. Persisted state must contain the exact raw provider content parts (including thought signatures), provider call IDs, scope and call budgets. `take` must atomically consume the state to reject replay. The Google `generateContent` API does not return a general conversation cursor: `opaqueRef` remains `null`, never fabricated. Multi-turn history is reconstructed by Node from the **current, unexpired session only**.

Do **not** use an in-memory `PendingFunctionStore` for production. The store reference must point to durable agent/session scoped persistence with encryption, TTL, concurrency safety and explicit unknown-outcome reconciliation. A consumed pointer cannot be retried blindly after an interrupted external action.

## Offline and live certification

Offline typecheck: `npx tsc -p services/api/src/gemini/tsconfig.p1.json` (requires `@types/node` workspace dependency).

Offline suite after compilation: compile with `npx tsc -p services/api/src/gemini/tsconfig.p1.json --noEmit false --outDir /tmp/gemini-p1-dist`, then `node --test /tmp/gemini-p1-dist/services/api/src/gemini/adapter.test.js`.

G1 live compatibility status: **BLOCKED_LIVE_COMPATIBILITY** until a valid API key, approved File Search test store/document, actual model identifier, and pinned SDK version are supplied by the integration owner. No mock response constitutes proof of real source annotations, tool support, or reliability.

### Integration-owner handoff (outside P1 file ownership)

1. Add and pin `@google/genai` in `services/api/package.json` and workspace lockfile. Verify its version against the selected stable API model and use `createOfficialGeminiAdapter(process.env.GEMINI_API_KEY, options)`.
2. Change the API TypeScript build configuration or package contracts resolution so type-only imports from `packages/contracts/gemini-v1.ts` do not violate API `rootDir: "src"` (TS6059). P1's independent `tsconfig.p1.json` can typecheck the frozen shared contract without changing restricted files.
3. Build trusted `AgentRuntimeBinding` and a `PendingFunctionStore` backed by PostgreSQL, scoped to `agentId`, `sessionId`, `requestId`, exact file store revision, deadline and unique call IDs. Never pass these values from browser/model tool arguments.
4. Supply Node registry definitions from `AgentToolRegistry.definitions(trustedContext)`. Dispatch function requests only with `AgentToolRegistry.execute(...)` and Node action authorization, consent and outbox controls. Persist turn outputs only after P4 evidence checks.
5. Explicitly orchestrate `knowledge` / `functions` phases. Do not enable `combinedToolsLiveVerified` until the pinned SDK/model supports File Search + custom functions in the exact same request, verified live.
6. Run a G1 matrix (greeting, supported/unsupported question, real File Search annotations, read-only function call and result continuation, same-session multi-turn, combined tools, timeout, auth failure, 429/5xx) with **redacted** provider evidence and model identifier. Test 60-minute expiration and restart recovery separately.

### Known compatibility gaps

- Model-specific Gemini function call IDs can be absent on some provider outputs; this adapter **fails closed** rather than inventing IDs.
- Gemini File Search citations can lack exact store/document/version references; P4 must resolve approved provenance or reject material claims.
- SDK dependency, live API key and real store are not available to this P1 branch. Offline mocks verify only local authorization, normalization and state-transition logic.
- The `models.generateContent` surface is stateless. Raw signed provider function-call content is retained in Node-owned pending state; `opaqueRef` stays null. The Interactions API and its `previous_interaction_id` are not silently substituted.