# Customer chat (Track C)

Next.js 16, TypeScript, Tailwind v4, bundled/self-hosted Inter. This is a customer-only UI for **Sara · ANCFZ**. No Foundry SDK, model logic, business actions, or fabricated production fallback lives in the browser.

## Environment and run

In the repository root, install npm workspace dependencies and run `npm run dev -w @ai-service-agent/web` or `npm run build -w @ai-service-agent/web`. Through Nginx the app is on `/` and calls Node through same-origin `/api/` routes. The public `NEXT_PUBLIC_AGENT_KEY` build setting defaults to `ancfz`; configure it to the actual Node-published agent key if different. This key is public, not a credential. No API base URL or browser Foundry secret is used.

## Ticket session and delivery semantics

- Node creates and authorizes its own guest/customer HTTP-only session cookie. The UI only saves an **opaque ticket ID** under `ai-service-agent.active-ticket.<agentKey>` in local storage as a reload hint. It is not a bearer token. Every GET, POST and SSE request must be independently ownership-checked by Node; a stored ID cannot authorize access.
- On initial load, GET the hinted ticket. Only HTTP 404 clears the hint and creates a new ticket. Network/server errors display a real error and do **not** silently create another ticket. On an active ticket, session loss requires the customer to explicitly retry.
- Each POST contains a UUID `requestId`; retries of an unacknowledged identical draft reuse that ID. HTTP **202 Accepted** is only durable customer-message acceptance; the UI does not claim that Sara has finished.
- SSE uses native credentialed `EventSource`, named event handlers, event-ID deduplication (bounded 512) and automatic Last-Event-ID replay **during automatic reconnect**. Following a full reload, GET the authorized ticket snapshot; after each SSE connection/reconnection also reconcile the snapshot. Message IDs deduplicate history and realtime events.
- Backend source references are displayed only when present. Only HTTPS citation URLs without credentials, obvious private hosts or signed query secrets become clickable. Text and inline `**bold**`, `*italic*`, and backticks are rendered as escaped React text; no raw HTML or tool-call JSON is rendered.
- An operation's queued/running/completed status, if published later, is a separate notification; the web app never initiates business side effects.

## Backend integration assumptions and remaining contract work

`packages/contracts/openapi.yaml` freezes the four paths and HTTP payloads but **does not yet specify exact SSE event payload envelopes**. The UI accepts full `ChatMessage` values, `{message: ChatMessage}`, `{reply: ChatMessage}`, and `{ticket: Ticket}`, with named event types `message.accepted`, `agent.processing`, `agent.response.completed`, `agent.response.failed`, plus relevant aliases and future operation events. Events with only identifiers trigger a ticket snapshot refresh. The integration owner must finalize event names, payload shapes, complete/error semantics and ensure durable ordered event IDs, replay, and authenticated access.

Node must set the guest session cookie on the same origin (HttpOnly, SameSite, Secure once TLS is enabled). Production must use TLS; the current port-80 deployment is **POC/local only**. The backend must enforce agent and ticket authorization; browser validation is not a security boundary.

## Manual smoke checklist (when Node API is integrated)

1. On desktop and mobile, open `/`. Check header, empty state, composer, 320px overflow, focus order and Enter/Shift+Enter.
2. Start a guest ticket; submit a message and inspect network. Expect POST 202 and no fabricated assistant reply.
3. Verify `agent.response.completed` with authorized `ChatMessage` and actual citations, and a separate failure event with readable error.
4. Refresh and verify GET restores authorized history; change/remove session and confirm no cross-session access.
5. Force an SSE interruption. Confirm reconnect and event dedup; full refresh must rehydrate from PostgreSQL.
6. Try malformed/unsafe source URLs and malicious HTML in message text; no script execution or secret-bearing link.

**Validation distinction:** A successful Next build proves bundling/types, not live Sara integration. No fixtures or fake Sara response paths ship in this UI.
