# Gemini P7 — direct integration status

**Branch:** `experiment/gemini-file-search-poc` **only**.  
**No PRs. No changes to `main`.**  
**G0 frozen base:** `8078e46e0f55a543d19260acac430c0b4ee14716`.

## Integration carried out

- Reviewed P1–P6 source heads, common G0 ancestry, non-overlapping file ownership and offline feasibility.
- Fixed P2 malformed disposable DB test runner on `feat/gemini-persistence` (`cfec98678eeea7e6231f5a53bef854973aed5605`).
- Directly imported **40 P1–P6 feature files**, preserving all six source histories, in experiment-only 7-parent merge `17153bf864f813e8b27a10d9990cd80f5872585e`.
- Repaired malformed SQL literals in `gemini-qualification.ts` and integrated TypeScript's frozen contracts as `@ai-service-agent/contracts` local workspace package.
- Pinned `@google/genai` to `2.32.0` in experimental API; no credential committed.
- Updated experimental Compose API build context to repository root, Dockerfile to build shared contracts and Node workspace, blank `GEMINI_API_KEY` in example and model ID forwarded to isolated migration owner.
- Added P7 CI: immutable feature SHA preflight, combined API build/offline P1/P3/P4/P5/P6 suites, G0 invariants, real API Docker image build and isolated disposable PostgreSQL migration/catalog/session gate.

## Measured gates

| Gate | Current outcome |
| --- | --- |
| P1–P6 isolated offline preflight | **6/6 jobs passed** at `a7b85c2725bbff16bfed52047d14212216ee4aec`, run 43620726466 |
| Combined API build + offline adapters + G0 invariants | **3/3 passed** at `a5dc51254e1163c2b14a99064b8f9d72d6a2c4c6`, run 43621941308 |
| Compose config + workspace-aware API Docker image build | **Passed** at `d48f798f4a325f9183377bac130bf201eaa02834`, run 43622409387 |
| Disposable Gemini migrations: fresh/repeat/checksum/RLS/catalog seed | **Passed through initial SQL/seed checks** in run 43622561162; complete P2 test is **not yet green** |
| P2 Node session integration | **Blocked**: `42P08` timestamp parameter ambiguity; `$8` on session insert fixed at `adfd1fd7dc7cfb092a6711419fa9a39f2ec24da7`, `$3` on acceptance fixed in subsequent integration commit. Exact-head database rerun must pass. |
| Live Gemini API + File Search + combined function calls | **NOT EXECUTED**; requires isolated credentials and approved test store/document |
| One Node-owned Gemini chat, verified before SSE/persistence | **NOT IMPLEMENTED**; current turn worker still invokes Foundry |
| Real n8n provider / customer journey | **NOT CERTIFIED** |

## Mandatory P7 work remaining

1. Make disposable P2 DB/session integration completely green. Do not interpret a passing SQL migration as passing the Node repository.
2. Implement P3's real `KnowledgeRepository` on top of P2's scoped persistence and approved source storage; no production mocks.
3. Resolve **exact document attribution** for Gemini File Search. P1 currently maps `retrievedContext.fileSearchStore` (store) to `providerResourceName`; P4 requires an exact approved document ID. The Google generateContent `GroundingChunkRetrievedContext.documentName` field is not available in Gemini Developer API. Verify a concrete custom-metadata or Interactions file-citation strategy with live provider evidence; never guess source identity from titles or similar snippets. Documentation: https://ai.google.dev/gemini-api/docs/file-search and https://googleapis.github.io/js-genai/release_docs/interfaces/types.GroundingChunkRetrievedContext.html.
4. Create a persistent Node-owned pending-function state adapter to resume Gemini tool interactions safely; preserve opaque provider context and signatures required by the selected API.
5. Replace Foundry-only `runtime/turn-worker.ts` / `turn-queue.ts` and HTTP ticket creation/admission/expiry with **one** Gemini pipeline; use P2 60-minute session repo, G0 contracts, P1 client and P4 verifier **before** saving or streaming factual assistant messages.
6. Preserve trusted Node tool authorization and idempotent n8n operations; never let a model call a webhook directly or duplicate an operation after timeout.
7. Replace Foundry source download behavior with exact authorized source mapping; remove Azure/Foundry-only dependencies after verified cutover.
8. Run exact-head Docker/Postgres, local n8n, real Gemini File Search and P6 security/quality gates. No production/readiness claims from offline mocks.

**Stop condition:** Do not activate Gemini factual responses or describe P7 as complete until verified exact source attribution, fail-closed grounding and safe session/tool continuation are demonstrated. No web-search fallback. No PR into main.

This is a status record, not a promise that unfinished work runs asynchronously.
