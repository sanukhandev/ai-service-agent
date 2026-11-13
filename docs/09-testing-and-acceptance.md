# Testing strategy and acceptance gates

## Evidence standard

Mark tests **mock**, **local integration**, or **live external**. Never call a mock test a production Azure/n8n pass. Report exact code SHA, environment, test command, total/passed/failed/skipped and actual trace/correlation IDs without secrets.

## Test pyramid

| Layer | What it proves |
|---|---|
| Unit | Contracts, parsers, authorization rules, state transitions, consent and PII adapters |
| Contract | Node/Python request/response, Foundry tool schemas, n8n callback payloads, SSE events |
| Database integration | Fresh migrations, RLS, composite FK, transaction boundaries, idempotency and outbox locking |
| Docker smoke | Nginx single host port, private services, health, volume persistence, Angular static, Next rendering |
| Live Foundry | Published GPT-5.4 agent, identity, native IQ retrieval, citations and real tool errors |
| Workflow integration | n8n dispatch, approval, provider evidence, callback replay and reconciliation |
| Browser E2E | Guest and verified customer journey, SSE recovery, document upload, admin operations |

## P0: repository and infrastructure

- Formatting/lint/typecheck/test/build commands exist and run successfully when apps are implemented.
- `docker compose config` passes and **only** nginx publishes `80:80`.
- Angular static assets render at `/admin/` with deep-link refresh; Next.js renders `/`.
- All private service ports are inaccessible directly from host.
- No real secrets, API keys, OTP or customer PII in repository or test snapshots.
- PostgreSQL fresh migration applies with an auditable ledger and no `vector` extension.

## P1: Foundry + working web chat

Live tests:
1. `hello` -> normal Sara greeting, no unnecessary knowledge tool call.
2. `Tell me about ANCFZ` -> response grounded in actual FAQ/overview retrieval.
3. `What company types are available?` -> company-type material, not only FAQ.
4. `What packages are available?` -> Packages and Offers material.
5. `What does one visa cost?` -> actual pricing source with conditions.
6. `What IT consulting activities are supported?` -> activity source.
7. `Tell me more` -> additional relevant detail; no repeated overview.
8. `Create a quotation` before business tools -> does **not** claim success.

For every factual case capture source IDs, agent/version, tool calls and response. Passing plausible natural language without genuine evidence is not a retrieval pass. Verify the agent has the knowledge MCP tool; a created agent with no attached tools is not sufficient.

## P2: ticket durability and event replay

- Two customers and two agents cannot access each other's ticket messages or events.
- Restart Node/Redis while ticket is active; messages and event cursor remain recoverable from PostgreSQL.
- Retrying the same customer message request does not create duplicated accepted messages.
- Ticket facts/summary revisions remain scoped and source-linked.
- SSE reconnect resumes from last acknowledged durable sequence without cross-ticket data.

## P3: catalog and functions

- Tool call input/output schema validation, size limits, budget/timeouts.
- Model cannot choose a different `agent_id` or `ticket_id` through a tool argument.
- Unknown, disabled and cross-agent tools denied.
- Intent requirements can be collected across turns without repetitive questions.
- Formal quote calculation uses structured versioned prices, not free-form RAG output.
- Read tool never creates side effects.

## P4: actions and n8n

- Customer authorization is bound to exact action and current proposal.
- Unauthorized or missing prerequisite actions denied.
- Two simultaneous approvals cause one committed business request/outbox item.
- n8n HTTP 2xx does not mark provider completion; verified callback/reconciliation does.
- Callback signature, replay nonce, provider correlation and duplicate result tests.
- Unknown provider outcome remains explicit; retries cannot double-create leads/quotes.

## P5: identity, documents and privacy

- OTP TTL, throttling, non-enumeration, reuse and replay denial.
- OTP/credentials never enter model request, logs or telemetry.
- Presidio tests for names/emails/phones and representative false positives; preserve authorized contact fields while masking unnecessary PII.
- Upload file-size/type validation, agent-scoped object access isolation and malformed file handling.
- OCR derived fields retain provenance and review status; AI extraction never silently validates identity.

## P6: admin and release review

- Admin RBAC cannot access another agent's configuration without authorization.
- Catalog draft/publish/version pin works, including active ticket stability.
- Basic accessibility and responsive browser tests for both UIs.
- Load/test p50, p95, p99 latency, tool-call budget and concurrency with representative traffic.
- Review live external failures, observability, resource access, data retention and HTTP/TLS boundary.

## Failure classifications

Use `FAILED_TOOL_EXECUTION`, `FAILED_RETRIEVAL`, `INSUFFICIENT_EVIDENCE`, `AUTHORIZATION_DENIED`, `INVALID_CONTRACT`, `PROVIDER_OUTCOME_UNKNOWN` and `FAILED_UI` or typed equivalents. Separate retrieval coverage failures from prompt-quality and Azure credentials failures.

## Exit gate

Do not declare the system production-ready from successful Docker boot or mocked Foundry outputs. The final report must distinguish implemented, tested, live-verified and deferred capabilities, and call out that public HTTP/interactive Azure CLI credentials are POC-only.
