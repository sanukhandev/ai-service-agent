# Gemini model adapter — active P7 implementation

The Node API uses `@google/genai` and the Gemini Developer API `models.generateContent`. The model ID, persona, store and tool allowlist come only from the trusted, published, session-pinned `ModelTurnRequest` contract. The adapter returns candidates, **never** independently authorized final business claims.

## Runtime ownership

- `services/api/src/runtime/gemini-worker.ts` is the sole invoking worker.
- `services/api/src/repositories/gemini-pending.ts` provides durable, encrypted, agent/session-scoped pending function state. No in-memory production continuation.
- `services/api/src/agent/tool-registry.ts` validates business function requests and executes only published Node handlers with trusted ticket scope.
- `services/api/src/runtime/gemini-evidence.ts` and `services/api/src/grounding/index.ts` resolve independently approved source/catalog evidence **before** assistant persistence or SSE publication.
- `services/api/src/runtime/turn-queue.ts` owns durable queue and response publication. The provider does not own ticket state or business side effects.

`runTurn(request, {phase: 'functions' | 'knowledge' | 'combined'})` advertises only authorized capabilities. The worker currently separates function and File Search phases. Do **not** enable the combined-tool mode without a real, pinned-model G1 result. No public web search, URL Context, browser tool, arbitrary web fallback or SDK-side business execution is permitted.

Gemini function requests contain IDs/arguments which Node validates against the tool registry. To continue, the worker returns authorized results through `continueWithFunctionOutputs` and atomically consumes encrypted provider parts/signatures. Model argument IDs, customer scope and provider continuation must never be trusted as an authorization token. Missing function IDs or ambiguous source identity fail closed.

## Source annotation boundary

A File Search store name is not a document identity. An annotation must resolve to an exact provider document resource or unique, provider-verified metadata tuple matching agent/store/document/version/SHA-256 in PostgreSQL. The independent P4 verifier then checks claim support against approved retained original/normalized text. Unapproved/revoked sources or unsupported business facts must not reach customer-visible assistant messages.

## Tests and certification

```bash
npm run build --workspace @ai-service-agent/api
npx tsc -p services/api/src/gemini/tsconfig.p1.json --noEmit false --outDir /tmp/gemini-p1-dist
node --test /tmp/gemini-p1-dist/services/api/src/gemini/adapter.test.js
```

The branch CI also exercises fake-model worker/database integration and source isolation. These are offline proofs. **Live G1 compatibility remains unverified** without isolated Gemini credentials, actual temporary File Search indexing, citation metadata and function roundtrip. The billable, synthetic-only probe is `scripts/gemini-g1-live.mjs`; see [P7 status](../../../../docs/gemini-p7-status.md).
