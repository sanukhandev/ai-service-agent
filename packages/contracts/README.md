# Gemini experiment — API, agent and event contracts

**Canonical contract:** [gemini-v1.ts](gemini-v1.ts) and its independent [G0 freeze record](../../docs/gemini-g0-contracts.md).

The active application uses Node/Fastify for ticket admission, agent authority, function execution, durable events, grounding verification and external workflow authorization. Gemini is an external model candidate generator; File Search is the only permitted built-in retrieval tool. Node enforces the exact agent, session, model, store, document provenance and allowable functions.

## HTTP and event boundaries

- `GET /api/health` — Fastify health
- `POST /api/v1/agents/{agentKey}/tickets` — authorized ticket creation
- `GET /api/v1/tickets/{ticketId}` — ticket ownership and status
- `POST /api/v1/tickets/{ticketId}/messages` — durable, idempotent customer message acceptance
- `GET /api/events/tickets/{ticketId}` — scoped SSE and database event replay

See [OpenAPI](openapi.yaml), [ticket event contract](ticket-events.md), and implementation in `services/api/src/runtime/app.ts`. Node issues IDs, manages guest/customer ownership and accepts a customer request before inference. An HTTP `202 Accepted` means the message was accepted, **not** that Gemini completed or a provider operation succeeded.

## Model and business contracts

- Gemini model invocation, authorized function declaration/call/continuation, source annotations and usage: `gemini-v1.ts`.
- Node registry: `find_intents`, `select_ticket_intent`, `get_intent_requirements`, `record_ticket_facts`, `get_offerings`. Other operation/status interfaces may be defined but must not be advertised until their Node handlers and permissions exist.
- Material business claims need independent approved evidence qualification before assistant message persistence or streaming.
- Business side effects require Node preflight, customer consent, durable idempotent outbox and provider-confirmed outcome. The model cannot call n8n or CRM directly.

## Session and source policy

The AI session expires 60 minutes after the last accepted customer message. Reconnect does not reset its deadline. Expiry starts a new model conversation without prior AI context; historical tickets remain persisted. Source documents require agent-approved revisions, exact provenance and validated original text; store IDs or citation titles alone are insufficient.

The G0/G1/P7 workflows and `tests/gemini/` distinguish static/offline checks from live provider certification. Full live G1, real Sara corpus and n8n/P6 validation remain acceptance blockers.
