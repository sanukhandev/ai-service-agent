# Data model and migration policy

**Current SQL:** `infra/postgres/001_core.sql` is the agent/ticket baseline; `002_intents_and_ticket_facts.sql` adds versioned Node-owned intents, offerings, price revisions, ticket intents, customer facts and fact history. The migration entrypoint applies immutable numbered migrations 003–015 with checksums; the disposable PostgreSQL integration gate validates migrations, RLS, catalog seed and sessions.

## Principles

Use **plain PostgreSQL 16** as the durable database. Fresh POC baseline; no legacy tenant schema, `pgvector` extension, embeddings or ANN indexes. Normalize operational entities (aim for 3NF/BCNF where practical), avoiding mixed-purpose catalog/ticket tables and unbounded event JSON in place of relational keys. JSONB is appropriate for immutable version snapshots, provider payloads and bounded structured fields, not as a substitute for key constraints.

An agent is the **top-level isolation partition**. Gemini model and File Search resource names are externally bound, not application primary keys.

## Logical entities (check SQL migrations for exact columns)

| Domain | Tables and principal fields |
|---|---|
| Agents | `agents(id, agent_key, display_name, status, created_at)`, `agent_versions(id, agent_id, version_number, provider, model_id, persona_version, knowledge_version_id, publication_state, published_at)`; agent versions pin model/persona/knowledge/catalog policy |
| Permissions | `agent_tool_grants(agent_id, agent_version_id, tool_name, enabled)`, `agent_admin_memberships(agent_id, principal_id, role)` |
| Intent catalog | `intent_catalog_versions(id, agent_id, revision, status)`, `intents(id, agent_id, catalog_version_id, intent_key, name, description, examples, allowed_actions)`, `intent_requirements(id, agent_id, intent_id, requirement_key, value_type, required_for)` |
| Offerings | `offering_catalog_versions`, `offerings(id, agent_id, catalog_version_id, offering_key, intent_key, description)`, `offering_price_revisions(id, agent_id, offering_id, currency, amount, effective_from, effective_to, conditions)` |
| Identity | `agent_accounts(id, agent_id, normalized_email, verified_at)`, `auth_sessions(id, agent_id, account_id, guest_token_hash, expires_at)`, `auth_audit_events` |
| Tickets | `tickets(id, agent_id, ticket_number, account_id?, session_id, subject, status, created_at)`, `ticket_messages(id, agent_id, ticket_id, role, content, request_id, created_at)` |
| Ticket memory | `ticket_intents`, `ticket_facts(id, agent_id, ticket_id, fact_key, value, source_message_id, verification_status)`, `ticket_fact_events`, `ticket_summaries(id, agent_id, ticket_id, revision, summary)` |
| Events | `ticket_events(id, agent_id, ticket_id, sequence, type, payload, created_at)`, `event_outbox(id, agent_id, event_type, payload, status, lease_until)`, `event_inbox` |
| Documents | `ticket_documents(id, agent_id, ticket_id, blob_key, status)`, `document_extractions(id, agent_id, document_id, processor_version, status)`, `document_fields` |
| Operations | `action_definitions`, `workflow_bindings`, `action_requests(id, agent_id, ticket_id, action_key, status, idempotency_key, approved_at)`, `action_executions`, `provider_evidence` |
| Governance | `consent_records`, `audit_events`, `knowledge_bindings` |

Use UUID primary keys except where a monotonic per-ticket event sequence improves replay. Prefer normalization for versioned catalogs and distinct foreign-keyed rows for reference data. Add a separate immutable snapshot only when historical transactional interpretation requires it.

## Relationships and isolation

- Every agent-owned entity has `agent_id NOT NULL`.
- Add appropriate composite uniqueness and references, for example `UNIQUE (agent_id, id)`, ticket-to-message `FOREIGN KEY (agent_id, ticket_id) REFERENCES tickets(agent_id, id)`.
- Ticket account association must use `(agent_id, account_id)` to prevent cross-agent ownership.
- `agent_accounts` unique on `(agent_id, normalized_email)`; ticket numbers unique on `(agent_id, ticket_number)`; catalog keys unique within their published version.
- Operations unique on `(agent_id, integration_binding_id, idempotency_key)` or another carefully specified, stable execution scope.
- Use PostgreSQL RLS on agent-owned tables with a transaction-local trusted agent setting. RLS does not replace authentication, composite FK constraints or service authorization. Deny default access when the scope is unset.
- Scope Redis keys, object storage paths, events and audit queries by `agent_id`.

## Index policy

Start with indexes supporting actual access patterns:
- `tickets(agent_id, status, updated_at DESC)`, `tickets(agent_id, account_id, created_at DESC)`
- `ticket_messages(agent_id, ticket_id, created_at, id)`
- `ticket_events(agent_id, ticket_id, sequence)` unique and ordered
- `agent_accounts(agent_id, normalized_email)` unique
- `event_outbox(status, available_at, id)` with a partial index if warranted
- `action_requests(agent_id, ticket_id, created_at)`
- Foreign-key supporting indexes where PostgreSQL otherwise lacks them.

Benchmark query plans before adding speculative GIN/JSON or broad indexes.

## Transaction rules

1. Accept user message and `message.accepted` event in one transaction.
2. Store assistant response and `agent.response.completed` in one transaction.
3. Record explicit action approval, action request and outbox entry atomically.
4. Worker claims use leases/locking and retries; external provider calls need stable idempotency keys.
5. SSE replays from durable `ticket_events`; Redis is only the live transport/cache.
6. Do not mark a quote or lead completed until trusted provider evidence is persisted.

## Migration conventions

- Start with a brand-new schema baseline, split into ordered migration files by domain when useful: agent/identity -> catalogs -> tickets -> documents -> workflows -> RLS/indexes.
- Include a checked migration ledger (version, checksum, applied_at).
- Test every migration chain against a **fresh disposable** PostgreSQL instance in CI.
- After an applied migration is shared, use a new forward migration. Do not rewrite historical applied migrations.
- Do not delete database volumes or run `down -v` against anything containing data without explicit user authorization.
- Admin UI is deferred. Any POC configuration/seed scripts must run under controlled operator authorization; never commit an admin password, default credential or plaintext secret. Do not enable public admin registration.

## Retention and privacy

Store the minimum necessary personal data. Encrypt sensitive fields where appropriate, restrict transcript access and redact tracing. Customer uploaded documents and extracted fields remain private ticket artifacts, not agent-wide File Search knowledge content.

The existing schema is implementation-backed and tested through disposable migrations and integration CI. Live provider and full isolation/security certification remain separate acceptance gates; check numbered SQL migrations and the P7 report rather than treating this logical table as a complete DDL inventory.
