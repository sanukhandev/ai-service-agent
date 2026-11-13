# Track A — Direct Foundry Agent Service adapter

This directory is the **Node-only SDK boundary**. It does not create, update, or delete Sara; it does not introduce a model deployment, LangGraph, custom RAG, or business tools.

## Version and runtime contract

- npm packages: `@azure/ai-projects@2.8.0`, `@azure/identity@4.14.1` (exact direct versions; root workspace lockfile is integration-owned).
- Uses `AIProjectClient.getOpenAIClient()` and the Responses API with a `body.agent_reference` containing **name and version**.
- A `previous_response_id` is the continuation token. The integration owner must persist it on the authorized ticket, serialize turns per ticket, and never accept it directly from a browser.
- Native Foundry IQ remains configured and executed inside the published agent. Only response `function_call` items execute through the existing `AgentToolRegistry`.
- Function results return as `function_call_output` with the original `call_id` and `previous_response_id` of the pending response.
- All tool schemas must be **already published** on the same Sara version as the existing IQ MCP tool; this adapter cannot add them to an immutable version. Publish via a separate controlled process, preserving IQ. Do not attach `tools` per request because that can override the published native tool selection.
- SDK retries are disabled (`maxRetries: 0`) to prevent implicit replay after a durable tool side effect. Surface 429/5xx for Node to handle outside a partially executed turn. Limits: 4 rounds, 8 calls, 12 KB/function output, 60-second SDK/model budget (configurable).
- The existing `runNodeFunctionLoop` has call and round limits but cannot cancel a currently running tool handler. Each handler must implement its own deadline, idempotency and cancellation; this track does not modify handlers.

## API for the Node integration owner

```ts
import { FoundryClient, FoundryError } from "./foundry/index.js";

const foundry = new FoundryClient(toolRegistry); // Existing AgentToolRegistry instance.
const result = await foundry.runTurn({
  agentName: publishedAgent.name,
  agentVersion: publishedAgent.version,
  message: persistedCustomerMessage.text,
  conversationContext: { previousResponseId: ticket.foundryResponseId ?? undefined },
  trustedToolContext: {
    agentId: authenticatedAgent.id,
    ticketId: ticket.id,
    principalId: verifiedSession.principalId,
    sourceCustomerMessageId: persistedCustomerMessage.id,
    intentCatalogRevision: ticket.intentCatalogRevision,
    offeringCatalogRevision: ticket.offeringCatalogRevision,
    authorizedToolNames: authorizedRegisteredToolNames,
  },
});
// Persist result.text, result.sourceReferences, result.responseId and result.usage
// in the same authoritative ticket context before notifying the browser.
```

Sample variable names are the integration owner's domain objects, not imports from this track. Throwing `FoundryError` is deliberate: no partial output is represented as a successful assistant turn.

**Required integration work outside Track A:** wire Fastify route (`src/index.ts`), database-backed ticket ownership, conflict-safe response cursor persistence, registered intent/offerings handlers, per-agent authorization, and SSE. Track A owns none of those files. The published Sara version must include function definitions whose names and schemas match the Node registry. Unexpected names receive `TOOL_NOT_AUTHORIZED` rather than execution.

## Environment and Linux Docker CLI

Compose already mounts the named `azure-cli-auth` volume to `/home/app/.azure`; Track A changes **only the Dockerfile**. Supply environment variables using Compose's local `.env`, not image build arguments:

```dotenv
FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
FOUNDRY_AGENT_NAME=<exact-published-Sara-name>
FOUNDRY_AGENT_VERSION=<exact-published-version>
```

The Foundry project endpoint must be HTTPS. The runtime container is the unprivileged `app` user, with `AZURE_CONFIG_DIR=/home/app/.azure` and a writable named volume.

```bash
docker compose build api
docker compose run --rm --no-deps --entrypoint az api login --use-device-code
docker compose run --rm --no-deps --entrypoint az api account show --query '{name:name,id:id,tenantId:tenantId}' -o json
docker compose run --rm --no-deps --entrypoint az api account get-access-token --resource https://ai.azure.com --query expiresOn -o tsv
```

The first command installs Azure CLI in the image; the login command prints the browser/device-code instructions. **Never paste the generated code or token into a commit or a chat.** No Windows credential cache is mounted. For an existing root-owned volume, perform a one-time recovery via `docker compose run --rm --no-deps --user root --entrypoint chown api -R app:app /home/app/.azure`. A normal image rebuild does not delete the named volume. `docker compose down -v` does.

## Manual smoke verification

After the SDK is installed and the Compose volume is authenticated:

```bash
docker compose run --rm --no-deps --entrypoint node api dist/foundry/smoke.js
```

The CLI runs read-only `verifyPublishedAgent`, a greeting and a separate ANCFZ knowledge question. It uses an empty tool registry, so it **cannot execute application functions**. The knowledge check reports failure if no actual source annotations are returned. Override `FOUNDRY_SMOKE_KNOWLEDGE_QUESTION` to match an indexed, approved ANCFZ document. A real business-function continuation smoke requires the integration owner's registered handler implementation and a published compatible Sara version; do not invent one.

The standalone smoke intentionally does not depend on the Fastify route. It is not an authentication or authorization integration test.

## Limitations and failure signals

- `FOUNDRY_AUTHENTICATION_FAILED`: AzureCliCredential login/role scope is not valid.
- `FOUNDRY_AGENT_NOT_FOUND`: pinned agent/version missing, or the Node binding does not match configured Sara.
- `FOUNDRY_IQ_TOOL_FAILED`: Foundry reports a failed MCP/file-search invocation.
- `FOUNDRY_RATE_LIMIT`, `FOUNDRY_TIMEOUT`: do not replay a function continuation automatically.
- `FOUNDRY_INVALID_FUNCTION_CALL`: malformed call or duplicate call ID.
- `FOUNDRY_TOOL_BUDGET_EXCEEDED`: bounded loop exhausted.
- `FOUNDRY_FUNCTION_CONTINUATION_FAILED`: provider refused a tool-output continuation.
- `FOUNDRY_API_FAILED`: other SDK or response failure.

Responses expose only **actual** provider citations from output-text annotations; a missing citation stays missing. A returned IQ tool call is not itself a source citation.
