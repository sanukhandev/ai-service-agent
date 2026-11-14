# P6 Gemini certification harness

**Scope:** P6 only. G0 `8078e46e0f55a543d19260acac430c0b4ee14716`, contract `gemini-contract-v1`. Does not change the main runtime or make claims about Google access. Node 22+; no packages, Docker or credentials needed for offline mode.

## Execute

```bash
node scripts/check-gemini-certification.mjs --mode=offline
node scripts/check-gemini-certification.mjs --mode=offline --strict
node scripts/check-gemini-certification.mjs --mode=local --exact-sha=<INTEGRATED_40_HEX_SHA> --adapter=/absolute/path/to/integration-adapter.mjs
GEMINI_CERT_APPROVED_STORES='stores/test-agent-v1' GEMINI_CERT_SANDBOX_ENDPOINT='https://sandbox.example.invalid' \
  node scripts/check-gemini-certification.mjs --mode=live --exact-sha=<INTEGRATED_40_HEX_SHA> \
  --adapter=/absolute/path/to/live-adapter.mjs --live-confirm=I_AUTHORIZE_SANDBOX_GEMINI_CERTIFICATION
```

The local/live examples require **actual** adapters and authorized sandbox infrastructure; their placeholders must be replaced. Missing adapters, missing exact SHA, unsupported APIs or unavailable services mean **blocked**, never passed. A live adapter must not point at a production customer database, main stack, real payment provider, or uncontrolled n8n workspace. Exact commit must be checked out, and the supplied SHA must match it. Do not run destructive fault tests against a shared service.

## Evidence separation

- `offline`: deterministic policy simulator, fixed virtual clock and adversarial fixtures. Demonstrates that the harness assertions operate; **does not validate application modules**.
- `local`: real dedicated Compose/Node/PostgreSQL/Redis/n8n mock execution. Requires an integration-owner adapter and a controlled time seam, a disposable database and private network probes.
- `live`: real Gemini, approved test File Search resource IDs, real annotations and requests to explicitly authorized sandbox integrations. Record redacted provider request IDs and actual provider authorization outcome. Never use invented citations or costs.

Report JSON is emitted to `tests/gemini/reports/latest-<mode>.json` (gitignored); `--report=` overrides it. Do not commit secret-bearing logs, tokens, customer records or raw provider files. `0` exit: no failing assertions (offline may still have blocked external checks); `1`: actual test failures; `2`: incomplete coverage in local/live or `--strict`. The report always sets `certificationPassed: false` at P6 development stage; an independent integration-owner gate must certify exact-head results.

## Adapter interface (integration owner supplies implementation)

Export `createCertificationAdapter({mode, exactSha, root})` and `certificationIdentity({mode, exactSha, root})` from a module. Identity must report `{mode, exactSha, evidenceLevel:'local-integration'|'live-provider'}` with verified independent environment identity; never report local as live. Every test gets a clean adapter instance; isolate its database/session namespace to avoid cross-test interference. A local/live adapter must implement the same async primitives as `adapters/offline.mjs`:

- `evaluateGolden(fixture)` returns `{category,status,qualification,published,streamed,enabledBuiltinTools,usedEvidenceIds,checkedEvidenceCount,authorizedEvidenceCount,latencyMs,inputTokens,outputTokens,costUsd}`. The **published/streamed** flags must be measured after Node's verifier, not copied from a model candidate. Accepted evidence must map to approved source IDs; do not expose private provider IDs publicly.
- `probeSecurity(fixture)` returns `{allowed,leaked,externalCalls,logs,enabledBuiltinTools}` based on real negative probes. Redact secrets in logs while preserving canary-detection assertions.
- `createSession`, `session`, `setClock`, `sendMessage`, `getContext`, `poll`, `modelReply`, `browserRefresh`, `flushRedis`, `restartNode`, `addProviderContinuation`, `loseProviderContinuation`, `compressContext`, `proposeAction`, `providerOutcome`, `callBusinessTool` matching `certification.mjs` inputs. `setClock` must control **authoritative DB time/session admission** and the test database must be disposable. Implement auth with separate A/B customer credentials and agents; never let the model provide scope.

For **local/live** infrastructure gates `i04`–`i09`, implement `probeInfrastructure({probe,mode,exactSha})` on the external adapter. Return `{status:"passed",exactSha,evidenceReferences:[...nonempty independently verified proof IDs]}` only after checking isolated Compose, database migrations/checksums, seed idempotency, actual webhook ingress, G1 File Search request/annotation/continuation evidence, and independent credential/resource fingerprints. Missing implementation stays `blocked` rather than faking a success. The integration owner must approve any needed runtime seam; do **not** modify shared contracts or runtime in P6.

## Test coverage and interpretation

`fixtures/golden.json`: approved, partial, missing, conflicting/retired/revoked, invalid price, semantic paraphrase, multi-claim, natural social/clarification, external general knowledge, web attempt, cross-agent citation, approval-backed catalog, embedded document injection, operation success claim and missing annotation. Each case records expected status, category, allowed evidence IDs, publication rule and explanation. No text-equality scoring or lexical overlap threshold.

`fixtures/security.json`: knowledge/ticket/document scope, model-selected store ID, source revoke/download, retrieved/customer prompt injection, forbidden builtins, secret canary, consent, unauthorized workflow and unverified payment/CRM outcome. `t01–t16`: complete 60-minute matrix including sliding boundary, exact expiration, refresh, Redis loss, restart, fact correction, concurrent admission, provider continuation, summarization and in-flight action. `w01–w16`: call allowlist, malformed/duplicate calls, intent/requirement tools, fact idempotency, consent, outbox and uncertain/verified provider outcomes. `i01–i09`: Compose and integration-only infrastructure gates.

### Important scoring limits

Mock latency is **not** provider latency and is reported as `null`. Null tokens/costs are unknown, not zero. A source-authorization percentage from mock fixtures is not production accuracy. A passed offline case only verifies the test double; real security sign-off must use a completed local run and independently attested live run on the exact integrated commit. Rerun all tests when the contract or integration SHA changes.

### Integration blockers at G0

1. P1 must prove Gemini/File Search annotation and function-continuation compatibility, and expose verifiable provider request IDs.
2. P2 must provide the 60-minute transactional session model, controlled database time, independent runtime role, migration/seed and recovery hooks.
3. P3 must provide approved test stores/documents, immutable provenance and download authorization.
4. P4 must connect grounding qualification **before assistant persistence or SSE** and expose internal evidence trace safely.
5. P5 must expose sandbox n8n outbox/callback reconciliation and prevent duplicate effects.
6. Integration owner must supply safe local/live adapter modules and private environment, certify ingress/credentials and execute all gates at exact integrated SHA. No PR or main modifications are part of P6.
