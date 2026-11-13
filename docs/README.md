# Development documentation

These documents are the **target design** for the clean `ai-service-agent` repository. They do not mean a component has been implemented.

| Document | Scope |
|---|---|
| [Product and scope](01-product-and-scope.md) | Users, features, scope and invariants |
| [Architecture](02-architecture.md) | Components, ownership, network and message flow |
| [Foundry and conversation](03-foundry-and-conversation.md) | Versioned Foundry agent integration and model interaction |
| [Data model](04-data-model.md) | Normalized PostgreSQL, agent isolation and migration policy |
| [Tools, actions and workflows](05-tools-actions-workflows.md) | Application function registry, authorization and n8n |
| [Security and privacy](06-security-and-privacy.md) | Agent/account isolation, OTP, PII and secrets |
| [Docker and deployment](07-docker-and-deployment.md) | Nginx port 80, Compose, auth-volume and health |
| [UI guidelines](08-ui-guidelines.md) | Tailwind v4, Inter, Next.js + Angular simple UIs |
| [Testing and acceptance](09-testing-and-acceptance.md) | Mock/live evidence and measurable gates |
| [Implementation plan](10-implementation-plan.md) | Incremental workstreams and execution ownership |

## Architecture rules

- [AGENTS.md](../AGENTS.md) is the repository-wide engineering contract.
- Agent is the domain/isolation root; the app has no Tenant entity.
- One model path: Node -> Python -> published Foundry Agent -> Foundry IQ; native IQ retrieval is not a Node function call.
- Node owns durable ticket/business state and authorization; model reasoning is advisory.
- `n8n` executes only preauthorized operations, with verified results.
- Only Nginx exposes host port 80. Internal containers communicate via Docker DNS.
- The first working vertical slice is greeting + knowledge retrieval + persisted ticket + customer response.

## Documentation change control

Keep documentation synchronized with implemented contracts, actual environment variables, migration files, and tests. Label unimplemented features clearly; no fictional API successes. Record deliberate design changes in a PR and update affected docs together.

This project is an independently built POC. Legacy history can inform tests and security patterns, but none of the previous runtime's routes, migrations, schemas or V1/V2 compatibility paths are normative here.
