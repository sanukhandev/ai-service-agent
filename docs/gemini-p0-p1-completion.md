# P0 + P1 completion runbook (isolated Gemini experiment)

Branch: `experiment/gemini-file-search-poc` after verified integration from
`feat/gemini-p0-p1-completion`. Do not apply any of this to `main`.

## Changes

- The model may call `preflight_operation` or `propose_operation` only when
  permitted in its *published* agent version. A proposal is a durable,
  idempotent ticket record; it **never authorizes or dispatches n8n**.
- The Node-owned per-agent `agent_action_bindings` table selects the
  known-safe executor and whether an action requires passport/Emirates-ID
  extraction. Unknown/disabled actions are unavailable. Runtime has
  `SELECT` only; only the migration/operator manages bindings.
- `find_intents` includes the complete 21-intent catalog in one request and
  exposes bounded paging for larger catalogs. Lexical scores order candidates,
  but never exclude a published intent solely for zero keyword overlap.
- Azure OCR remains the default. `IDENTITY_OCR_PROVIDER=gemini_vision` is
  only available with `APP_ENV=development` and
  `ALLOW_SYNTHETIC_GEMINI_OCR=YES`. Only invented test identity documents
  may be submitted. Gemini OCR is extraction, not identity or authenticity
  proof; do not turn it on for real data.
- Existing published agent versions are immutable. To activate the new tools
  for *new* tickets in an existing isolated POC, apply the explicit
  `infra/bootstrap/publish-gemini-operation-tools.sql` with the
  PostgreSQL migration-owner account. It creates a new agent version if needed;
  old ticket bindings remain unchanged.

## Offline gate

Run exact-head G0 + P7 CI, including disposable PostgreSQL migration 021/022,
API/Next/Docker builds, P2 integration, agent-scoped action registry and
nonexecuting proposal checks, and synthetic OCR parsing negatives.

## G1 live gate (billable, synthetic)

Set `GEMINI_API_KEY` privately in the *isolated* environment.
Only opt in after reviewing `scripts/gemini-g1-live.mjs`.
That script should verify greeting, File Search indexing/retrieval,
provider document identity, citation metadata, actual function call,
function continuation and temporary-store cleanup. On a missing key
or missing provider source metadata, report **blocked** rather than passing.

## Final real-time POC testing

After G1, use only synthetic test records and private sandbox credentials:
natural paraphrased intent queries, clarifications, action proposal,
customer consent, Salesforce Lead, approved quotation, secure documents,
OTP/2Checkout sandbox, independently verified status and TEST invoice.

Payment dispatch remains off until independently validated. No real
identity documents or public HTTP transactions are permitted.

**Not certified by offline CI:** live Gemini File Search, real OCR/provider
accuracy, sandbox CRM/payment responses, complete end-to-end live P6.
