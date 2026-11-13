# POC API and event contracts — P0

**Status:** contract-first; business and Foundry endpoints are not yet implemented. See [HTTP specification](openapi.yaml) and [frozen guest/session/SSE event contract](ticket-events.md).

The customer browser calls only Node via Nginx. **Node calls Microsoft Foundry directly** through its JavaScript SDK, and executes client-side function calls against its internal allowlisted tool registry. No Python Gateway or `/internal/turns` service.

- Server resolves `agentId`, ticket ownership and active Foundry agent version; never delegate authorization to model arguments.
- JSON API uses `camelCase`. IDs are issued by Node. `requestId` provides idempotent customer message acceptance.
- Node persists accepted customer messages before inference; `202 Accepted` never means the model completed.
- SSE exposes event IDs and per-ticket replay from PostgreSQL, not just Redis.
- Typed tool failures and missing business evidence cannot become false success.
- Future catalogs and action contracts are versioned.

## Initial public API

```text
GET  /api/health
POST /api/v1/agents/{agentKey}/tickets
GET  /api/v1/tickets/{ticketId}
POST /api/v1/tickets/{ticketId}/messages
GET  /api/events/tickets/{ticketId}
```

Access to ticket endpoints is bound to a server-issued guest/customer session. Real routes beyond `/api/health` will be added in P2.

## Foundry function names for P3/P4

`find_intents`, `select_ticket_intent`, `get_intent_requirements`, `get_offerings`, `get_ticket_context`, `get_document_data`, `preflight_operation`, `propose_operation`, `get_operation_status`.

These run inside Node and do not themselves authorize workflow execution. The future n8n approval API uses a separate customer confirmation, Node preflight and durable outbox entry. Native Foundry IQ remains attached separately as the agent's knowledge tool.
