# Gemini POC: live-test readiness (no Admin UI)

The active experiment is deployed separately from Foundry: Compose project
`ai-service-agent-gemini`, host `127.0.0.1:2000`, isolated database and
n8n volumes. All ordinary payments remain disabled.

## Before your first real chat

On the *experiment* branch, after fetching the tested commit:

```powershell
git switch experiment/gemini-file-search-poc
git pull --ff-only origin experiment/gemini-file-search-poc
Copy-Item .env.example .env
```

Set these locally in your untracked `.env`:
- `GEMINI_API_KEY`: a Google Developer API key authorized for the configured Gemini model.
- `GEMINI_STATE_ENCRYPTION_KEY`: 32 random bytes as 64 hexadecimal characters.
- `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD`: **different** random values, 16+ characters.
- Keep `APP_ENV=development`, `COMPOSE_PROJECT_NAME=ai-service-agent-gemini`,
  and `PUBLIC_BASE_URL=http://localhost:2000`.
- Keep `ANCFZ_PAYMENT_DISPATCH_ENABLED=false` until independently approved.
- Sara persona and system instructions come from published, version-pinned PostgreSQL
  configuration, **not** a model-prompt environment variable. The editable source is
  `infra/bootstrap/sara-persona.sql`. On a fresh database it publishes v2.
  For an existing active Sara v1 database, use the explicit version publication below.

Do not upload real customer records, identity documents, or business knowledge during the initial G1 probe.
The initial Sara seed **does not create a File Search knowledge store**.

```powershell
# Before starting containers: configuration check, no Google calls or writes
node --env-file=.env scripts/check-gemini-live-readiness.mjs --scope=chat --docker
docker compose up -d --build
docker compose ps
# Read-only runtime checks (do NOT call Gemini)
node --env-file=.env scripts/check-gemini-live-readiness.mjs --scope=chat --docker --db --health
```

If upgrading an existing Sara v1 installation, explicitly activate the
reviewed v2 instructions for **new tickets only**, then disable the opt-in:

```powershell
# Change GEMINI_SARA_PUBLISH_PERSONA=YES in your private .env for this run.
docker compose run --rm migrate
# Restore GEMINI_SARA_PUBLISH_PERSONA=NO in .env immediately afterward.
```

The publication is idempotent and preserves the existing model, catalog,
knowledge binding and prior tools; it adds only the two approved inert
operation-proposal tools if absent. Existing tickets remain pinned to
their original persona/version. Do not run a public or customer PII session
on this local HTTP POC.

Visit `http://localhost:2000`. A PASS here means configuration and local
health only, **not** that the model, retrieval, or workflows are live-certified.

## Live G1 compatibility (billable, synthetic only)

After the local preflight passes:

```powershell
$env:GEMINI_API_KEY=(Get-Content .env | Select-String '^GEMINI_API_KEY=').ToString().Split('=',2)[1]
$env:GEMINI_G1_ALLOW_BILLABLE_RUN='YES'
$env:GEMINI_G1_MODEL_ID='gemini-3.8-flash'
npm install --ignore-scripts --no-audit --no-fund
npm run build --workspace @ai-service-agent/api
node scripts/gemini-g1-live.mjs
Remove-Item Env:GEMINI_G1_ALLOW_BILLABLE_RUN
Remove-Item Env:GEMINI_API_KEY
```

This explicitly billable G1 script creates/indexes an invented document in a
temporary store, verifies citations, function call and continuation, and deletes
the store. It does **not** prove the production knowledge corpus is accurate.
If it fails, do not start factual customer Q&A until the exact provider response
and expected metadata are reconciled without weakening the Node grounding gate.

## Knowledge and the business journey

The second stage requires operator approval, indexing, publication and binding
of Sara's actual trusted documents; do not assume a successful G1 synthetic store
is the business knowledge store.

```powershell
# Read-only scope check; fails if Sara has no published bound knowledge.
node --env-file=.env scripts/check-gemini-live-readiness.mjs --scope=knowledge --docker --db --health
```

The verification commands **do not** mutate the knowledge store. Follow
`scripts/ingest-agent-knowledge.mjs` for the controlled source review and
publication workflow. Check real paraphrases, unclear intents, grounding,
citations, consent, action proposals, 60-minute expiry and session isolation.

Only after manual Salesforce/n8n sandbox configuration, import, activation and
credential validation, use:

```powershell
node --env-file=.env scripts/check-gemini-live-readiness.mjs --scope=workflow --docker --db --health
```

An n8n workflow structure or HTTP 200 response does not prove Salesforce success.
Use separately approved synthetic customer data and provider-correlated results.

Payment is a separate gate. Do not enable it as part of the first live chat or
File Search test. The current synthetic-only Gemini OCR is not real identity
verification. Real document processing requires approved OCR and document
handling, and an invoice must not be generated without independently verified
payment. The unapproved source-derived test catalog cannot authorize binding
pricing.

## Release/no-go rules

Configuration preflight PASS, offline CI PASS and live G1 PASS are **different**
acceptance results. A failed live G1, missing knowledge version, unsupported claim,
unknown action, or unverified payment status is a NO-GO for that downstream stage.
Never expose POC HTTP ingress publicly or use genuine PII in synthetic tests.
