# P3 — Published Sara Agent configuration and integration

This document is a **controlled publication checklist**, not evidence that Azure has been modified. P3 calls the existing published Microsoft Foundry Agent Service from Node directly. Sara continues using her native Foundry IQ connection. No Python gateway, LangGraph, pgvector, web-search tool or custom RAG engine is deployed.

## Export the exact Node function manifest

Build the existing API first:

```bash
npm install --no-audit --no-fund
npm run build --workspace @ai-service-agent/api
node services/api/dist/foundry/export-tools.js > sara-p3-functions.json
```

The output contains precisely the five function definitions registered in `registerIntentTools`: `find_intents`, `select_ticket_intent`, `get_intent_requirements`, `record_ticket_facts`, `get_offerings`. Use their exact published argument schemas and descriptions. The Node runtime independently verifies the `toolNames` allowlist, arguments, pinned catalog membership, authorized ticket and customer-message provenance.

## Publish without altering an existing version

1. Read `services/api/prompts/sara-service-employee.md` and review privacy/consent boundaries. The P3 persona explicitly says lead or CRM submissions **are not enabled**.
2. In the authenticated Foundry project, create a **new** Sara agent version derived from the approved existing version; **preserve the existing native Foundry IQ knowledge MCP connection**, its access control and approved knowledge configuration.
3. Add the five exported client-executed function tools. Do not replace the IQ tool or add web/bing browsing.
4. Assign the reviewed persona instructions to that new version; inspect the full configuration and test a greeting, grounded knowledge answer, and every function call/continuation.
5. Publish the new version intentionally; record the true agent name, version, project endpoint and IQ retrieval results. Do not publish or switch versions automatically during a customer request.
6. **For a fresh database only**, configure the new version before starting the migration/seed service. For an already seeded database, update the active binding through a separately reviewed configuration publication transaction; do not mutate the previous published version in place.

```dotenv
FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
FOUNDRY_AGENT_NAME=<actual-published-agent-name>
FOUNDRY_AGENT_VERSION=<exact-new-version>
```

For local POC `AzureCliCredential`, authenticate in the API container with the configured private `azure-cli-auth` volume. Never commit login cache or access tokens. A local prompt or JSON change does **not** update Foundry.

## Authoritative ownership and retry policy

The browser submits only a text and requestId. Node persists the customer message before 202, and PostgreSQL records a recoverable turn. A worker executes only against a trusted, agent-scoped ticket claim. The Foundry Responses API returns a real `responseId`; `previous_response_id` advances in the same DB transaction as the assistant message, durable SSE event and turn completion. No synthetic provider conversation ID is stored.

If a worker disappears after an uncertain provider outcome, the turn becomes `uncertain` instead of replaying possible side effects. This is intentionally a fail-closed recovery state and requires review; it is not automatic completion. P4 authorizes actual workflows separately.

## Verified / unverified evidence boundaries

Offline CI can prove TypeScript and Next.js builds, isolated PostgreSQL migrations, RLS, message idempotency, guest ownership and SSE replay. It cannot prove a **live** Sara call, Foundry IQ retrieval, tool schema publication, genuine provider citations or browser-to-Foundry response. Those gates remain **BLOCKED** until authenticated Azure execution and evidence collection.

Do not mark the POC complete solely on a passing compile or mock test.
