# Gemini experiment documentation

The only active AI runtime on `experiment/gemini-file-search-poc` is the Node-owned Gemini model adapter with Gemini File Search, scoped PostgreSQL persistence, independent Node grounding verification and optional authorized n8n workflows. The separate `main` branch is not modified.

## Source of truth

- [Development contract](../AGENTS.md) — authoritative implementation, isolation and security rules
- [Gemini implementation plan](gemini-experiment-implementation-plan.md) — original G0–P7 requirements, ownership and gates
- [Frozen G0 contracts](gemini-g0-contracts.md) — versioned session, evidence, policy and tool definitions
- [P7 implementation and certification status](gemini-p7-status.md) — verified tests, outstanding provider/UAT requirements
- [Main → Gemini integration record](gemini-main-sync.md) — ANCFZ catalog, 2Checkout mock, document workflow and migration conflict resolutions
- [P7 integration preflight](gemini-p7-preflight.md) — branch/source integration evidence

## Architecture and engineering guides

- [Product scope](01-product-and-scope.md)
- [Node / Gemini / knowledge architecture](02-architecture.md)
- [Gemini conversation and function continuation](03-gemini-and-conversation.md)
- [PostgreSQL data model](04-data-model.md)
- [Intent, tools and approved n8n workflows](05-tools-actions-workflows.md)
- [Security and privacy](06-security-and-privacy.md)
- [Isolated Docker deployment](07-docker-and-deployment.md)
- [Customer chat UI](08-ui-guidelines.md)
- [Testing and acceptance](09-testing-and-acceptance.md)
- [Delivery phases and certification dependencies](10-implementation-plan.md)
- [Node-owned intent conversation](11-intent-conversation-and-node-ownership.md)
- [ANCFZ workflow contracts](ancfz-p4-workflow-contract.md)

## Non-negotiable behavior

Node owns authorization, agent/ticket scope, business catalogs, durable messages, consent and external effects. Gemini can request allowlisted functions, but cannot authorize itself or call arbitrary workflows. The only built-in knowledge tool is approved agent-scoped Gemini File Search. Node verifies material factual claims independently **before** persisting or streaming an assistant answer.

The AI context has a 60-minute inactivity timeout; persisted historical tickets are not AI memory after expiry. Published source documents and pricing must be explicitly approved. Green offline CI does **not** establish live model/retrieval, financial/provider outcomes or production security readiness.

There is no active Foundry/SDK agent publication path on this experiment branch. Historical numbered SQL migrations are immutable for database compatibility; any cleanup of obsolete DB columns requires a new forward migration.
