# Architecture — Node as the only business backend

## Runtime

```mermaid
flowchart TD
  Customer[Customer browser] -->|HTTP /| Nginx[Nginx :80 only]
  Nginx -->|/| Web[Next.js :3000 internal]
  Nginx -->|/api and SSE| API[Node Fastify :4000 internal]
  API --> DB[(PostgreSQL 16)]
  API --> Redis[(Redis)]
  API -->|@azure/ai-projects + AzureCliCredential| Sara[Published Sara Agent GPT-5.4]
  Sara -->|native MCP retrieval| IQ[Foundry IQ knowledge]
  Sara -->|client-executed function requests| API
  API -->|authorized outbox worker only| N8N[n8n internal]
  API --> Blob[Private Blob Storage]
  API --> OCR[Azure Document Intelligence]
```

**No Angular admin, Python gateway, independent intent engine, LangGraph, pgvector or custom RAG container.** The app is agent-centric: ANCFZ is a sample configured Agent, not a global Tenant.

## Authority matrix

| Owner | Responsibilities |
|---|---|
| Foundry Agent | Natural conversational decisions, selecting a knowledge or application tool, asking questions |
| Foundry IQ | Grounded descriptive information from approved business knowledge |
| Node | Agent/ticket session authority, function registry, intent/offerings catalog, persistent facts, consent, action eligibility, outbox, SSE and verified outcomes |
| PostgreSQL | Durable transactional state and agent-scoped integrity/RLS |
| Redis | Cache, rate limiting, temporary challenges and event fanout, never sole truth |
| n8n | Executing Node-approved external integrations, never selecting its own authorization |
| Next.js | Customer chat, ticket state, explicit approval, identity forms and documents |
| Nginx | Public port 80 ingress only; route / to web and /api/ to Node |

## Turn lifecycle

1. Browser submits message to Node, which resolves agent, authenticated guest/customer ticket and published catalog/Foundry binding.
2. Node commits the customer message and event, then retrieves bounded ticket context and known facts.
3. Node calls the **existing** pinned Foundry Agent through JavaScript SDK.
4. Foundry may answer directly, retrieve Foundry IQ or emit a client-executed function call.
5. Node validates the function name/JSON and agent allowlist, executes the handler within trusted Node scope, then returns `function_call_output` to **the same Foundry conversation**; bound rounds and output size.
6. When finished, Node stores response, source references and SSE ticket events. A tool error is not an invented successful answer.
7. When customer explicitly approves a prepared business operation, Node atomically records authorization/outbox. An internal worker dispatches n8n; verified provider evidence updates the ticket.

The Foundry IQ MCP function remains managed by Foundry, **not** a Node business function. This is the deliberate difference between RAG and the application tool registry.

## Boundary principles

- The model cannot supply trusted `agentId`, `ticketId`, provider URL, workflow name or credentials.
- Only **registered and agent-authorized** Node handlers may execute; publishing tool schemas to Foundry does not grant access by itself.
- A customer-stated fact is tracked with source message/provenance. Corrected facts update durable state.
- Model selects useful questions; the catalog describes missing fields **per operation** and doesn't enforce a rigid order.
- Public browser routes: `/`, `/api/`, `/api/events/`. No `/admin/`, `/ai-gateway/`, n8n editor or database public route.
- Docker service-to-service traffic uses Docker DNS, never unnecessary public Nginx hops. Compose uses a **frontend network** (Nginx, Next.js, Node) and a **backend network** (Node, PostgreSQL, Redis, n8n), so Next.js cannot address n8n or the databases directly.
- HTTP port 80 is for isolated local POC only; no public exposure of real OTP, PII or uploads without TLS.

See [intent orchestration](11-intent-conversation-and-node-ownership.md).
