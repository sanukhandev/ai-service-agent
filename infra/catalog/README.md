# ANCFZ source-derived test catalogs

This folder is an **agent-specific example**, not a platform-wide hardcoded product catalog.

- `ancfz-test-2026.json`: canonical, reviewable source data.
- `seed-ancfz-test.sql`: PostgreSQL publication transaction.
- `scripts/publish-ancfz-test-catalog.sh`: explicit operator entry point.

## Coverage

- 21 actionable intent definitions with keywords/examples and action-specific requirements.
- 97 offerings/service entries including 8 business-activity category summaries and 55 priced licence/visa-package variants.
- All 55 documented 2026 package rates: 0–10 visas × 1–5 year terms.
- Other sourced offers: Pay As You Go, zero-visa and all-inclusive package summaries, executive office, retail package, flexi/shared/private office, four company structures, visas, bank/payment referrals, entrepreneurship, compliance and ANCFZ contact channels.

This is **not** a complete list of the 3,500+ licensable activities: the supplied activity-category documents list selected examples and categories, not all official activity codes. Use Foundry IQ or the complete official activity file for exact individual licence codes.

## Publication (test POC only)

1. Build/start the normal PostgreSQL service and apply baseline migrations **001–005**. The database already needs the restricted P0 `agent_runtime` login.
2. Configure `.env` with:
   ```
   POSTGRES_PASSWORD=<strong-migration-owner-password>
   POSTGRES_APP_PASSWORD=<different-strong-runtime-password>
   POSTGRES_DB=ai_service_agent
   FOUNDRY_PROJECT_ENDPOINT=https://<project>.services.ai.azure.com/api/projects/<name>
   FOUNDRY_AGENT_NAME=<published-sara-name>
   FOUNDRY_AGENT_VERSION=<published-sara-version>
   ANCFZ_CATALOG_ENV=test
   ```
3. Run **only when you intend to publish test data**:
   ```bash
   bash scripts/publish-ancfz-test-catalog.sh --publish-test
   ```
4. On Windows, run it from **Git Bash**, typing `bash scripts/publish-ancfz-test-catalog.sh --publish-test` without copying any decorative characters. The publisher stages the large JSON file using `docker cp` and only passes a short file path to PostgreSQL. It does not send 90 KB as a Windows/Docker command-line argument.
5. Repeat the same command safely: the checksum/seed receipt detects an identical seed, leaving the catalog records unchanged.
6. To publish changed data, use **new** `seedKey`, `intentRevision` and `offeringRevision` in the JSON. Historical published revisions are retired but remain readable by previously pinned tickets. Never update them in place.

There is no automatic seeding at HTTP server startup. No customer-facing administration endpoint is introduced.

## Tool behavior

The P3 Node functions can use the published intent and offering revisions returned by the authoritative agent binding:

- `find_intents`: indexed service goals and synonyms, **not** every knowledge topic.
- `get_intent_requirements`: action-specific questions; never turn every enquiry into a mandatory questionnaire.
- `select_ticket_intent` and `record_ticket_facts`: authorized persisted customer context, not workflow consent.
- `get_offerings`: use `visaCount` and `termYears` for exact package variants, otherwise return a bounded overview.

If a customer wants one visa for one year, `get_offerings({"visaCount":1,"termYears":1})` resolves `visa_1_y1` (AED 10,800 **total**, from the supplied 2026 table), with insurance and separate desk fees explicitly excluded/unverified.

## Important test-data and workflow boundaries

The uploaded RAG documents expressly mark their governance sections as **pending ANCFZ owner approval**. Per the POC request, catalog records are published in the test database anyway, and their price conditions clearly say **source-derived TEST**. Publishing is a DB lifecycle status; it is **not evidence of current ANCFZ authorization** or a binding quotation.

Do not expose this seed in production with real customers before commercial/legal review. A `generate_quote` action key in the catalog describes a future operation; it **does not authorize** execution. P4 Node preflight, explicit consent and verified provider outcome remain mandatory.

Bank partner approval is never guaranteed. Health insurance is excluded from visa package prices. One-year rates include the source-described advance-payment discount, while multi-year amounts are **total amounts for the selected term**, not annual rates. No separate desk fee is provided in the documents.

The seed does not modify Foundry IQ or publish model function definitions. A published Foundry agent version must have matching Node function declarations for tool calls to work.
