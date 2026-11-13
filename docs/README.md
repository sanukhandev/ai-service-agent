# AI Service Agent — POC documentation

**Current design:** Next.js customer UI -> Nginx (public port 80 only) -> **Node Fastify API -> published Microsoft Foundry GPT-5.4 Sara Agent -> native Foundry IQ**. Node owns intent catalog, function registry/loop, ticket facts, approvals and n8n dispatch. PostgreSQL is durable; Redis is ephemeral.

**Out of scope for this POC:** Angular admin portal, Python Model Gateway, Python Presidio runtime, pgvector, LangGraph, hand-built RAG, full automated testing/hardening. Admin UI can return after POC as a separate phase.

| Document | Purpose |
|---|---|
| [Product and scope](01-product-and-scope.md) | Goals, capabilities and exclusions |
| [Architecture](02-architecture.md) | Node ownership and request flow |
| [Foundry and conversation](03-foundry-and-conversation.md) | Direct JavaScript SDK, function loops and RAG |
| [Data model](04-data-model.md) | PostgreSQL and agent-scoped isolation |
| [Tools and workflows](05-tools-actions-workflows.md) | Read functions, proposals and n8n |
| [Security and privacy](06-security-and-privacy.md) | Identity, PII, consent and credentials |
| [Docker and Nginx](07-docker-and-deployment.md) | One public port, local Azure CLI volume |
| [Customer UI](08-ui-guidelines.md) | Minimal Next.js, Tailwind and self-hosted Inter |
| [Testing and acceptance](09-testing-and-acceptance.md) | Smoke vs deferred H1 hardening |
| [POC phases](10-implementation-plan.md) | P0–P7 delivery plan |
| [Intent-driven employee conversation](11-intent-conversation-and-node-ownership.md) | How Node catalog, ticket facts and Foundry tools work |
| [Service employee instructions](../services/api/prompts/sara-service-employee.md) | Sara's natural, non-robotic prompt |

[AGENTS.md](../AGENTS.md) is the engineering contract. Current P0 files are scaffolds, not proof of a working Foundry or n8n integration.

## Implementation invariants

- Foundry picks questions and calls model-visible functions; **Node handles every application function**.
- Only native Foundry IQ handles RAG. Do not duplicate knowledge search in Node.
- Node persists selected intents, facts, customer corrections and events, not just unbounded model conversation history.
- Model functions never trigger n8n directly; explicit customer authorization is required for consequential operations.
- Admin UI is deferred. During POC, controlled configuration/seed scripts handle catalogs and agent bindings.
- All non-Nginx containers have no host \`ports:\`.

- [P3 Foundry integration, runtime persistence and controlled Sara publication](p3-foundry-runtime-and-publication.md)
