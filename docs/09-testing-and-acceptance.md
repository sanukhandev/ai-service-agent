# Gemini experiment — testing and acceptance

## What current CI establishes

The experiment's `.github/workflows/gemini-p7-integration.yml` checks:

- Node TypeScript, shared Gemini contracts and independent adapter tests;
- P3 knowledge normalization/transport tests and P4 grounding policy;
- P5 n8n adapter's deterministic offline tests;
- P6 golden/security/session/workflow **offline simulator** (not live application certification);
- Next.js customer build, Docker API image and experiment Compose configuration;
- disposable PostgreSQL fresh/repeat/checksum/RLS, catalog seed, 60-minute session and fake-model worker/API integration.

The G0 workflow checks immutable provider/tool/isolation contracts. Every new commit must pass its **own** exact-head runs. Previously green checks are not evidence for later revisions.

## Required but outstanding live gates

| Gate | Passing evidence |
| --- | --- |
| G1 Gemini API | Real Google model ID, synthetic File Search store and document, accurate document citation identity, custom metadata and permitted function request/continuation |
| Approved Sara corpus | Operator-approved source versions, actual retrieval, positive/negative business questions, independent source support and revocation |
| External workflows | Isolated n8n sandbox and real provider lead/quote/payment state, consent and idempotency under retry |
| Local P6 | Real Compose/Node/Postgres/Redis with full session, isolation, SSE and recovery probes against exact SHA |
| Live P6 | Real Gemini citations/latency/cost, false rejection, unsupported claim escape, security and negative tests |
| Deployment security | Credential separation, private document access, agent isolation, TLS before public access, audit trails and key handling |

The local/live P6 runner requires a real integration adapter and explicit authorization; missing infrastructure must be reported **blocked**, never silently converted to a success. See [P6 harness](../tests/gemini/README.md).

## Commands

```bash
npm install --ignore-scripts --no-audit --no-fund
npm run build --workspace @ai-service-agent/api
npm run build --workspace @ai-service-agent/web
node scripts/check-gemini-g0.mjs
node scripts/check-gemini-certification.mjs --mode=offline
bash infra/postgres/gemini-p2-validate.sh
```

`gemini-p2-validate.sh` uses an isolated disposable database and containers. It should never be pointed at an existing customer/project volume. The G1 synthetic script is opt-in, uses a temporary invented source and can incur charges. Refer to [P7 status](gemini-p7-status.md) for the supported trigger.

## Release verdict

Report each gate as `implemented`, `offline-verified`, `live-verified` or `blocked` with the exact tested SHA and evidence URL. Do not label the experiment production-ready while G1 and real n8n/P6 validations remain incomplete.
