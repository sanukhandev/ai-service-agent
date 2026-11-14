# Gemini P7 — Integrated experiment status (2026-11-14)

**Repository:** `sanukhandev/ai-service-agent`  
**Only integration branch:** `experiment/gemini-file-search-poc`  
**G0 shared baseline:** `8078e46e0f55a543d19260acac430c0b4ee14716`  
**Git policy:** Direct commits; no PR created; do not merge into or modify `main`.

## Verdict

**P7 source/runtime integration and deterministic local certification are implemented. Full live Gemini/File Search and external-provider certification are NOT complete.** Do not describe the experiment as production-ready or live-grounding-certified.

The legacy Foundry runtime and Azure SDK are absent from the experimental API image. The sole Node turn worker is `GeminiTurnWorker`; it must have `GEMINI_API_KEY` and `GEMINI_STATE_ENCRYPTION_KEY` and does not silently fall back to Foundry.

## Implemented and wired

| Boundary | Implemented behavior |
| --- | --- |
| Model | Node-pinned persona/model; Gemini API `generateContent`, authorized function declarations and bounded continuation |
| Source policy | File Search only; no Google Search/URL Context/browsing/code execution tools |
| Retrieval | Per-agent/version published File Search binding, human source approval, private retained originals |
| Citation identity | Exact provider document when supplied, otherwise only if Google-provided custom metadata matches the exact agent/session/store/document/version/SHA tuple against PostgreSQL |
| Response safety | Grounding verifier before assistant publication; factual claims fail closed when unverified; atomic response audit, message and SSE event |
| Business tools | Existing Node intent/fact/offerings tool registry; no model-directed n8n URL or provider calls |
| Operations | Existing authorized, idempotent n8n lead/quote workers remain single consumers; real provider outcomes are not certified |
| AI sessions | PostgreSQL-enforced 60-minute inactivity from accepted customer input, new ticket on expiry, historical tickets retained, no cross-session AI context |
| Continuation | AES-256-GCM encrypted, agent/session-scoped pending function state in PostgreSQL |
| RAG ingestion | PostgreSQL publication/revision adapter, source SHA-256, private normalized TXT/MD/DOCX and text-PDF sidecars for independent verification |
| Document downloads | Verified ticket/message reference, exact approved document, private vault path containment and digest; no Foundry/URL fallback |
| Client | Next.js uses new session response, rejects expired session and starts fresh conversation without importing old model context |
| Runtime | Experiment-only Compose at `127.0.0.1:2000`, independent PostgreSQL/Redis/n8n volumes, Node Docker image without Azure CLI/pgvector/Python |

Scanned PDFs with no extractable text require **separately approved OCR**; do not publish/qualify them without a verified normalized-text source. Existing ANCFZ test pricing and catalog are *unapproved*, so they cannot authorize financial claims by default.

## Reproducible offline/local validation

- `.github/workflows/gemini-p7-integration.yml`: G0 contracts, combined API TypeScript, standalone Gemini adapters, grounding/knowledge tests, Next.js build, Compose config, actual Docker API image build, disposable PostgreSQL migrations and session integration.
- Disposable P2 tests cover fresh/repeat/checksum, Sara catalog, RLS, 60-minute session expiry, Fastify HTTP ticket admission and a complete fake-model Gemini worker flow.
- Worker integration proves a supported greeting is atomically published and an invented AED price is replaced with a safe clarification; provider calls are **faked** in that test.
- P3 tests include transport-level exact metadata-to-provider-document mapping and synthetic TXT/DOCX/text-PDF normalization.
- Last confirmed fully successful prior run: [43629167120](https://github.com/sanukhandev/ai-service-agent/actions/runs/43629167120), all six jobs successful on the tested commit. Recheck newer exact-head runs after subsequent commits.

**Important:** Passing unit tests / synthetic offline integration is not a live claim about the Gemini API or a commercial RAG knowledge base.

## Remaining live acceptance gates (blocking P7 certification)

1. **G1 live Gemini/File Search:** Confirm real `@google/genai` SDK/model functionality, custom function calls, real indexed documents, source annotations and custom-metadata identity. Run only with actual Gemini Developer API credentials. Google may omit source metadata for a particular model/API surface; fail closed if so.
2. **Actual approved knowledge:** Operator approves Sara source documents and indexed store version; test positive/negative retrieval and independent claim support; verify text extraction/OCR on the real corpus and safe source downloads.
3. **External n8n business UAT:** Verify real sandbox lead/quotation/payment outcomes, idempotency and consent. Passing mock integrations are not provider successes.
4. **Full P6 live quality/security:** Measure grounded supported/unsupported cases, false rejections, cross-agent isolation, source revocation, live provider latency/cost and fail-closed behavior at exact integrated SHA.
5. **Environment configuration:** Keep API key and 32-byte AES-GCM key in local/CI secrets; configure a private approved originals root. Never commit credentials.

### Opt-in G1 synthetic smoke

A synthetic-only, explicitly billable test is provided at `scripts/gemini-g1-live.mjs`. It creates a temporary File Search store, indexes an **invented** document, verifies document IDs/citations/functions and attempts to delete the store. It does not upload business/customer data.

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run build --workspace @ai-service-agent/api
# Set GEMINI_API_KEY privately; use a model enabled in your Google project.
GEMINI_G1_ALLOW_BILLABLE_RUN=YES GEMINI_G1_MODEL_ID=gemini-3.8-flash node scripts/gemini-g1-live.mjs
```

A `workflow_dispatch` variant lives at `.github/workflows/gemini-g1-live.yml`, requiring the `GEMINI_API_KEY` Actions secret. Because GitHub ordinarily requires the workflow file to exist on the default branch for `workflow_dispatch`, the **local script is the reliable path without modifying main**. Do not relax the experiment-to-main prohibition merely to run the workflow.

## Operational restrictions

- Do not add `google_search`, `url_context`, external browsing, custom vectors or an independent Python gateway.
- Do not accept source titles, snippets or File Search store identifiers as document identity without trusted metadata verification.
- Do not automatically approve customer uploads or old unapproved catalog prices.
- Do not turn on a factual response bypass if retrieval/verifier is unavailable.
- Never claim a Google live test passed unless a real isolated credential and provider result were observed.

**Status distinction:** P7 implementation integrated / CI-gated; **live-release certification blocked** until the numbered external validations above have real evidence.
