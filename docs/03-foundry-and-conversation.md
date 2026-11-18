# Foundry Agent, native IQ and Node function calls

## Current binding

Use the existing, published **Sara** prompt agent on Microsoft Foundry with GPT-5.4 and its attached **Foundry IQ knowledge tool**. Keep the selected project endpoint, agent name and immutable agent version in a Node-managed binding. Do not create an agent per request, reset the knowledge base or build a second RAG engine.

## Node implementation

P1 introduces a small Foundry adapter in `services/api/src/foundry/`, using compatible `@azure/ai-projects` and `@azure/identity` versions. The local Docker runtime authenticates through **AzureCliCredential**, not a Foundry API key. The Linux Node container must have Azure CLI installed and a non-root writable `AZURE_CONFIG_DIR=/home/app/.azure`, stored on the existing private `azure-cli-auth` Docker volume. A valid CLI login can survive rebuilds; revocation/policy changes may require login again.

**Current runtime:** Node invokes the pinned Foundry agent with a bounded function loop. A successful P0 health check remains insufficient evidence of live Foundry availability or end-to-end workflow acceptance.

## Two tool classes

1. **Foundry-managed IQ MCP retrieval:** information/FAQ/package descriptions, indexed approved knowledge and source citations. Executed by Foundry; Node does not emulate the IQ tool.
2. **Node-executed application functions:** `find_intents`, `select_ticket_intent`, `get_intent_requirements`, `record_ticket_facts`, `get_offerings` and later ticket context, operation preflight/proposal/status. Foundry sees schema descriptions only; Node executes handlers against scoped PostgreSQL repositories.

To add functions, **publish a new Foundry agent version via supported SDK/REST tooling while retaining the IQ tool configuration**. Changing a Node handler or local prompt file does not update the deployed Foundry version. The runtime Node registry also enforces per-agent tool grants independently of Foundry configuration.

Microsoft documents agent function requests as **client-executed**; app code submits outputs and continues the same conversation. For Copilot-harness prompt agents, avoid `strict: true` on function tools. Verify the actual installed JS SDK types/API shape during P1 integration.

## Node tool loop

- Node persists accepted customer message, loads trusted context and calls the pinned agent.
- Foundry returns text, IQ citations or function requests.
- The Node adapter maps function requests to a bounded, typed loop in `services/api/src/agent/function-loop.ts`.
- The registry in `tool-registry.ts` validates name/arguments and executes in trusted Node ticket scope, not scope supplied by the model.
- Tool results are returned as `function_call_output` items to the same Foundry conversation; the agent may request another function or produce a final reply.
- Bound tool rounds/calls, payload sizes and timeouts; reject duplicate IDs and unknown tools. Persist final reply and source events in Node.

The function loop and PostgreSQL-backed ticket context are implemented; live Foundry/IQ and external provider acceptance must still be tested with valid credentials.

## Natural service-employee behaviour

Sara is a team member helping a customer toward the relevant business goal, **not** a robotic FAQ list generator. Use [service-employee instructions](../services/api/prompts/sara-service-employee.md) as the versioned prompt source.

Typical progression: hear a goal -> `find_intents` -> `select_ticket_intent` -> save explicit customer facts -> fetch missing requirements -> answer or ask **one relevant question** -> if the customer explicitly requests an action, use the server-owned `ConversationActionHandoff` to ask the next missing catalog fact -> present the existing separate Node approval control. Customer requests are persisted as **intent, not consent** in `ticket_events`.

For "software services, one visa, shared office", Sara should not request those again. A helpful next question is shareholder count (if necessary), not a four-field questionnaire. Price explanations can be answered immediately with verified knowledge/catalog values, while formal quotes use structured price revisions.

## Customer-requested actions through sandbox invoice

A company-formation conversation stays natural for FAQ/package requests. On an explicit quotation, lead, purchase, PDF or invoice request, Node persists a durable non-authorizing request event. After the Foundry turn and any `record_ticket_facts` calls, Node re-reads the **pinned** requirements and verified operation state. Missing facts, validation issues and action readiness are structured context for Sara; **the model chooses the next natural clarification instead of a fixed Node question list**. Node only overrides customer-facing prose with exact authorization proposals or independently verified/blocked provider states. Unrelated FAQs remain answerable even during a pending quotation.

The supported POC business path is: **verified Salesforce lead → acknowledged quotation/PDF → private OCR document intake → purchase consent → synthetic OTP → sandbox gateway verification → verified test invoice**. The model may explain status but must not execute operations, mark payments complete, or expose the invoice before independent evidence.

Customer chat hides Foundry IQ citation chips and knowledge/download hyperlinks by default. Source references remain stored for audit and server verification. Quotation and invoice PDFs remain available in their **authenticated workflow sections**. Re-enable chat references only through an explicit product decision; they are not required for internal grounding.

## Source quality and token budget

- Preserve traceable IQ citations and distinguish unverified service inclusions from confirmed facts.
- Do not report a non-existent workflow or false "lead created" status.
- Keep a bounded recent-message window and Node-persisted rolling summary/facts; avoid resending the entire conversation and duplicated RAG excerpts.
- On failed IQ retrieval, missing catalog, tool budget or Azure auth issues, return a typed failure and a useful customer-facing explanation. Never fabricate prices, citations or action outcomes.

See [Node intent ownership](11-intent-conversation-and-node-ownership.md) and [tool/approval policy](05-tools-actions-workflows.md).
