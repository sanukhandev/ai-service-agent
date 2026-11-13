# API and event contracts — initial P0 freeze

**Status:** contract-first foundation, runtime not implemented. [HTTP specification](openapi.yaml).

The contract is service-independent:
- The browser sends messages and receives ticket events only via the Node API.
- Node delegates model turns to the internal Python gateway.
- Application model function calls are subsequently authorized by Node.
- Foundry IQ knowledge is a **native agent MCP tool**, not a second Node knowledge API in this POC.
- Node derives agent/session/ticket scope, persists messages before inference and never trusts model-authored identity.

## Contract rules

- Stable JSON keys use `camelCase` at public API boundaries; database columns may use `snake_case`.
- IDs are server-issued; `agentId` and `ticketId` passed to Python are trusted metadata, not user-selected tool parameters.
- Every accepted user message has an idempotent `requestId`; the server returns `202 Accepted` after persistence, not after model completion.
- SSE events have monotonically ordered per-ticket event IDs, with an authenticated replay cursor.
- Tool errors/statuses are typed. A failed tool, absent evidence or n8n dispatch never counts as success.
- Version new incompatible contracts deliberately; change OpenAPI + service adapters together.
- The internal service token must never reach browsers, model messages or logs.

## API groups

```text
GET  /api/health
POST /api/v1/agents/{agentKey}/tickets
GET  /api/v1/tickets/{ticketId}
POST /api/v1/tickets/{ticketId}/messages
GET  /api/events/tickets/{ticketId}
POST /internal/turns                   # API -> Python only
```

Authentication/authorization design remains owned by Node; first guest session uses an opaque secure browser cookie. Secure customer OTP and admin APIs will be added as versioned contract extensions in P5/P6.

## Future function registry (P3/P4)

Read functions: `find_intents`, `get_intent_requirements`, `get_offerings`, `get_ticket_context`, `get_document_data`.

Operation functions: `preflight_operation`, `propose_operation`, `get_operation_status`. Model function invocation is **not** operation authorization. Actual execution uses a separate verified customer approval endpoint and Node outbox/worker.

Automated contract tests are deliberately deferred until H1, but implementation should retain compatible schemas rather than inventing divergent payloads.
