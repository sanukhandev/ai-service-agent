# Frozen P0 customer ticket / SSE wire contract

Status: **integration contract** for parallel Tracks B (repositories) and C (Next.js).
The runtime routes are not implemented in P0. The reference HTTP endpoints
and message schemas are in [openapi.yaml](openapi.yaml).

## Browser session and ownership

- Creating a guest ticket at `POST /api/v1/agents/{agentKey}/tickets`
  issues a cryptographically random, server-managed, HttpOnly cookie called
  `sa_guest`. Node stores a hash, not the raw token, and binds it to one Agent.
- Cookie: `Path=/api; SameSite=Lax; HttpOnly`. Set `Secure` whenever HTTPS
  terminates at the trusted ingress. HTTP is localhost/isolated POC only.
- Browser includes same-origin cookies; it never sends an Agent ID, secret
  session token or service credentials in a request body.
- The public `agentKey` is a lookup alias (ANCFZ sample: `ancfz`).
  The authorized Agent UUID is resolved in Node, not by the browser/model.
- A ticket UUID is only a locator, not access permission. Unauthorized and
  unknown ticket IDs return indistinguishable 404 errors.
- Frontend may remember an authorized ticket UUID locally to reopen after
  refresh, but the cookie remains the only guest bearer credential.
- Node pins the Foundry agent version and published catalog versions when
  creating a ticket, not on each new message.

## Message submission

`POST /api/v1/tickets/{ticketId}/messages` accepts:

```json
{"requestId":"7fc28310-a08c-4978-a142-86e6cd97213f","text":"I want to start an IT company"}
```

Node commits the customer message and associated durable event **first**.
Only then return `202 Accepted`:

```json
{
  "ticketId":"<ticket UUID>",
  "messageId":"<persisted UUID>",
  "requestId":"<same request UUID>",
  "status":"accepted"
}
```

`202` is not an AI response or workflow success. Reusing the same requestId
for the same ticket must return the previously accepted message, never a
duplicate customer message.

## SSE transport

`GET /api/events/tickets/{ticketId}` with the authorized same-origin guest
cookie streams events from the Node API. Each durable event has an increasing,
**per-ticket** PostgreSQL `ticket_events.sequence` integer. Browser EventSource
automatically includes `Last-Event-ID` on reconnection; Node must replay
all events after that cursor before sending live events.

One SSE frame:

```text
id: 12
event: assistant.message
data: {"ticketId":"<ticket UUID>","sequence":12,"occurredAt":"2026-11-13T10:00:00Z","payload":{"message":{"id":"<message UUID>","role":"assistant","text":"How many shareholders?","createdAt":"2026-11-13T10:00:00Z","sourceReferences":[]}}}

```

Supported **initial** event names and payloads:

| event | `payload` keys | Meaning |
|---|---|---|
| `message.accepted` | `messageId, requestId` | Customer message durably stored |
| `assistant.processing` | `requestId` | Model turn started/continuing |
| `assistant.message` | `message` (ChatMessage schema) | Final assistant message stored; citations when present |
| `assistant.failed` | `requestId, code, message` | Typed failure, not fake assistant content |
| `ticket.updated` | `status` | Authorized ticket lifecycle change |
| `operation.status` | `operationId, status` | Reserved for P4 approved operations |

`message` fields follow OpenAPI `ChatMessage`. `sourceReferences` are only
real, authorized citations; Node must withhold private Azure Search URLs or
non-public storage SAS links from customer-visible links. Unsupported/invalid
references may be displayed as plain source titles without clickable URLs.

Event `data` always contains `ticketId`, `sequence`, `occurredAt` and
`payload`; the SSE `event` field carries the event name. No raw model
function arguments, prompts or private credentials are included.

The server may send `: heartbeat` comment frames to keep connections alive.
Heartbeat comments are not durable events and have no IDs.

## Replay / synchronization rules

- `GET /api/v1/tickets/{ticketId}` provides the current durable message
  history (in deterministic order) and ticket details.
- On initial SSE connection, the server may replay the retained ticket event
  history. Client de-duplicates `assistant.message` by its message UUID and
  events by sequence number, so snapshot + replay cannot duplicate bubbles.
- Reconnect via EventSource's built-in `Last-Event-ID`. The browser cannot
  set arbitrary HTTP headers on native EventSource; don't depend on them.
- On a dropped SSE connection, never infer a failed/succeeded operation merely
  from disconnection. Reconnect and/or reload the authoritative ticket state.
- The Node API must perform ticket ownership checks **before** replay and
  before registering a live subscription. Redis fanout alone is not durable.
- Event IDs and customer message IDs must remain stable after restarts.

## Parallel integration ownership

Track B owns repository transactions, sequences and guest session persistence.
Track C owns client rendering, EventSource reconnection and local deduplication.
The integration owner maps repository events to the SSE frame and HTTP routes.
Track A owns Foundry invocations, not ticket storage or SSE transport.

Changes to this contract require coordinated updates to both backend integration
and UI; do not introduce an incompatible event naming scheme in a parallel track.
