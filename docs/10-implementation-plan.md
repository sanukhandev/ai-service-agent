# Implementation plan — POC first, testing and admin later

## Current state

P0 scaffolding and architecture docs exist in `main`. The Python Model Gateway and Angular Admin Portal have been **deleted from the active repository**. Node is the only business/model integration backend. The existing Foundry Sara agent with native IQ retrieval is the selected AI runtime.

**Do not claim the live Node-to-Foundry integration is working yet.** Node has a health service and P3 tool registry/repository scaffolding, but the real Foundry SDK adapter, ticket endpoints, tool wiring and n8n workflows remain integration work.

## Phases

| Phase | What is built | Success condition |
|---|---|---|
| **P0 Foundation** | npm workspace, contracts, minimal Next.js/Node, Nginx port 80 only, PostgreSQL baseline | Builds, containers start, migration initializes fresh DB, only Nginx exposed |
| **P1 Foundry Direct** | `@azure/ai-projects` and `@azure/identity` in Node, container Azure CLI, existing Sara GPT-5.4 and IQ, supported function-call continuation adapter | Real greeting and cited knowledge answer via Node, IQ tool remains attached |
| **P2 Conversation** | Node ticket/session repository, message persistence, factual memory, SSE + replay, React chat | Customer can chat, correct facts and resume ticket after refresh |
| **P3 Intents and Offerings** | Node-owned versioned catalog, customer fact tools, published Foundry function definitions and trusted registry | Sara discovers supported services, remembers facts, asks one relevant question and reads approved offering data |
| **P4 Authorized Workflows** | Node preflight/proposal, customer confirmation, DB outbox/worker, n8n approved lead/quote templates, verified provider evidence | Verified CRM lead/quote outcome without model-executed side effects |
| **P5 Customer Features** | Email OTP, private document uploads, Azure Document Intelligence OCR, optional Node privacy adapter | Identity/documents operate securely through Node, never in agent tool calls as secrets |
| **P6 Integration** | Combine independent slices; repair startup/permissions/API/UI workflow gaps | Functional services and correct bounded tool loop across customer journey |
| **P7 POC Acceptance** | Demonstrate complete business enquiry, knowledge, catalog, action, auth/document flows | Live end-to-end POC with transparent caveats and no fictional outcomes |
| **H1 Hardening** | Dedicated automated tests, full CI, security review, load/performance and observability | Measured production-readiness gates (after POC) |
| **Future Admin** | Angular admin UI, catalog publication and agent management | **Separate later project**, not a POC delivery gate |

## Safe parallel development

After shared contract ownership is frozen:
- **Track A — Foundry:** `services/api/src/foundry/`; Node SDK, AzureCliCredential and function response adapter.
- **Track B — Data:** `infra/postgres/`, Node ticket + catalog repositories, RLS/runtime user.
- **Track C — Customer:** `apps/web/` Next.js/Tailwind chat/ticket.
- **Track D — Workflows:** `infra/n8n/` generic templates and Node action/approval contract.
- **Track E — Context:** `services/api/src/agent/` tool registry, intent and fact logic (Node only).

The integration owner maintains `services/api/src/index.ts`, `packages/contracts/`, `docker-compose.yml` and `infra/nginx/`. Parallel workstreams avoid concurrent writes to shared files. There is **no Angular or Python workstream**.

## Key dependencies

- Real Foundry adapter and published function definitions precede live tool calls; keep IQ MCP configured when publishing a new agent version.
- All catalog data and facts are persisted by Node/PostgreSQL. The Foundry agent chooses dialogue/questions but never owns durable customer state.
- A model function request can read intent/offerings data or persist sourced customer facts, but cannot invoke n8n/CRM directly.
- Lead/quote execution requires customer-specific Node approval, durable operation/outbox and verified provider evidence.
- The same customer can ask FAQ questions without starting a lead; only explicit requests start a business action.
- No dedicated test-suite development until H1, but basic build/migration/live smoke verification is still required.

## Starter sequence

1. Confirm P0 Docker build and SQL migration `001` + `002` in a fresh disposable DB.
2. Add Azure CLI to Node API image; prove direct Sara greeting and native IQ retrieval.
3. Build Node ticket persistence and Next chat with SSE/replay.
4. Wire `tool-registry.ts`, `intent-tools.ts`, `function-loop.ts` and scoped repositories into the live Foundry function-response loop.
5. Publish a Sara version with business function **definitions** and [service-employee prompt](../services/api/prompts/sara-service-employee.md), preserving existing IQ tool.
6. Prove intent identification, customer fact corrections, helpful next questions and authorized offering data.
7. Implement external action proposals/approvals/outbox/n8n.
8. Implement secure OTP and private documents/OCR.
9. Demonstrate P7; begin H1 and future Angular Admin only after POC.

Report exact committed SHA, what was built, live smoke observations and blockers for each milestone. Documentation/scaffolding is not proof of runtime integration.
