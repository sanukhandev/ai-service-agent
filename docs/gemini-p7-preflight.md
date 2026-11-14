**Historical pre-integration snapshot (G0).** The blocking findings below describe the original workstream heads **before** P7 integration. They are retained for audit history, not as the current runtime status. See [P7 status](gemini-p7-status.md) for implemented fixes and remaining live-provider certification.

# P7 preflight — Gemini experiment integration audit

**Status:** P7 preflight started; feature-code integration **BLOCKED** pending objective branch and provider-contract checks. This is not a certification claim.

**Integration target:** `experiment/gemini-file-search-poc`  
**Frozen shared base:** `8078e46e0f55a543d19260acac430c0b4ee14716`  
**Review baseline:** experimental HEAD `8078e46e0f55a543d19260acac430c0b4ee14716`; `main` not a merge target  
**Merge mode:** direct experiment-branch commits only, **no PR**.  
**Safety:** no writes to `main`, no shared Docker volumes or Google File Search stores.

## Reviewed feature heads

| Stream | Exact reviewed head | Changed files | Preliminary finding |
| --- | --- | --- | --- |
| P1 model adapter | `5a0f2e73cf43e22407b6ca52779f6e33d0028681` | 4 | Offline adapter; G1 live Gemini/annotation/function test not certified |
| P2 persistence | `464914bd11c720c61cb5c27b920f7ab4b2f49ba8` | 15 | New migrations 009–013; malformed/duplicated `gemini-p2-validate.sh` must be repaired |
| P3 File Search | `969b5c62af4c21c4ad41dad25bf97e6705e3e0b8` | 7 | Provider/ingestion code; P2 `KnowledgeRepository` bridge not implemented or validated |
| P4 grounding | `898413bbddbfdda000fefe34f8e8c77bc3af4334` | 3 | Offline verifier; requires trusted exact document evidence and integration before persistence/SSE |
| P5 n8n bridge | `423ad02cfde243793c4f22f9b04cd0f11d3b9765` | 4 | Offline bridge; legacy operation workers must be deconflicted; real n8n/provider E2E pending |
| P6 certification | `79c23d2b4b3a6c7b4faba936ffb8c9af1d19a0df` | 7 | Offline harness; local/live adapter and exact-head runs absent |

All six compare as descendants of the same G0 commit, each ahead with zero commits behind; no path overlaps between feature changes. This proves only Git isolation, **not functionality**. GitHub Actions had no runs on these six heads at review time.

## Blocking findings / integration acceptance gates

1. **P2 validation shell script malformed:** `infra/postgres/gemini-p2-validate.sh` contains a broken `grep -q '^postgres` conditional and a duplicated, out-of-order test block. Enforce `bash -n` before any database test. Repair and execute fresh/repeated migration, seed and RLS tests in isolated disposable containers before marking P2 ready.
2. **Provider annotation identity mismatch:** P1's `annotations()` sets `ProviderSourceAnnotation.providerResourceName` from `retrievedContext.fileSearchStore` (the store, when present), while P3 returns exact document resource names and P4 matches `providerDocumentResourceName`. The mismatch fails authoritative citation resolution. Do not guess a document by title or source URI; prove an exact, immutable document mapping using live File Search and current Google API response format, then fix provider normalization and tests together.
3. **P2–P3 repository contract not wired:** P3 declares a `KnowledgeRepository` interface requiring human approval, document status changes, CAS publication and private original storage; the P2 source currently exposes other repository interfaces. Provide a real agent-scoped implementation. Never pass mocks to production publication CLI.
4. **No P7 single Node turn:** the experimental worker still invokes Foundry. Integrator must replace it with Gemini, attach P2 session/recovery and P4 verifier before any factual message persistence or SSE. Do not activate any new provider adapter until the verifier is on the sole outgoing factual path.
5. **G1/live certification missing:** P1 and P3 report no verified live Gemini File Search/function combination, P6 has no local/live adapter. No access to a real Gemini test key, approved store/document or isolated Docker execution was proven in this review.
6. **Existing n8n operation workers may conflict:** P5 requires the integrator to choose a single worker for lead/quote operations; never enable two consumers of the same outbox.
7. **Dependency/build wiring pending:** P1 needs a pinned `@google/genai`, appropriate TypeScript contract resolution, and a durable server-owned pending-function state store; shared package/root files are integration-owner only.

## P7 execution order after blockers

- Gate A: Run automated immutable-feature-head preflight. Repair failed P2 shell/tests in an isolated child branch; re-review SHA and rerun.
- Gate B: Verify live Gemini + File Search evidence semantics and decide unified identity contract; reconcile P1/P3/P4 as a coordinated change with P2 repository adapter.
- Gate C: Directly integrate nonoverlapping features into the experimental branch **only after** source/CI/security review. Use checked parent SHAs and preserve individual feature history. Never merge into `main`.
- Gate D: Wire migrations/bootstrap, knowledge, model, verifier, workflows and P6 into the existing Node runtime; explicitly disable Foundry route on experiment.
- Gate E: Exact-head Docker/PostgreSQL and live-provider certification; no unverified factual streaming, no web/URL tool, no expired-session context, no unauthorized workflow actions.
- Gate F: Remove obsolete Foundry-only experimental dependencies only after sole Gemini runtime is verified. Report measured results, blockers and exact commit.

**No feature-code merge is authorized by this audit alone.** Fail closed on missing evidence, bad scripts and unsafe integration rather than silently declaring P7 complete.
