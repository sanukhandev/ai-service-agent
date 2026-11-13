# P2 persistence integration contract

This folder owns additive migrations 003, 004 and 005; the pre-existing 001 and
002 are unchanged. Apply 001 -> 002, then P0 role bootstrap, then 003 -> 004 -> 005 to a fresh disposable
database, or apply ONLY unapplied numbered scripts to an existing database.
Never rerun 001/002 or reset a persistent volume. Use a migration ledger and
content checksums in the integration owner's deployment orchestration.

## Runtime account

P0 bootstrap creates the restricted `agent_runtime` LOGIN with an isolated
`POSTGRES_APP_PASSWORD`. Migration 004 reuses that role and reduces its broad
bootstrap table grants to the operations actually required by these repositories.
Migration 005 grants the additional provider conversation table access.

Use the P0 Compose `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER=agent_runtime`,
`PGPASSWORD` environment settings. An optional `DATABASE_URL` may override
the PG* connection parameters. The application runtime starts by calling
`db.assertSafeRuntimeRole()` and rejects any user other than `agent_runtime`
or one with superuser / BYPASSRLS privileges.

No new `ai_service_runtime` group or second app login is necessary. The
`postgres` migration owner must never serve application requests. All
agent-private SQL runs in a transaction after Node applies trusted
`SET LOCAL app.agent_id`; RLS supplements, not replaces, ticket ownership checks.

## Integration patch required outside Track B ownership

1. Docker Compose owner: mount the new SQL files under
   /docker-entrypoint-initdb.d for FRESH databases; run the new migrations
   separately in existing databases. Keep the P0 API PG* connection variables pointing
   to the restricted agent_runtime login (or configure DATABASE_URL explicitly). Do not supply POSTGRES_USER=postgres to API.
2. Fastify owner: create ONE PersistenceDatabase on startup, await
   assertSafeRuntimeRole(), and onClose await db.close(). Construct
   AgentRepository, GuestSessionRepository, TicketRepository,
   TicketMessageRepository, ConversationContextRepository and
   TicketEventRepository and ConversationContinuityRepository from it.
3. Auth owner: resolve agentKey on the server, validate active/published
   configuration, verify a cookie-bound guest token or secure authenticated
   account session, then construct a TicketScope. Never accept accountId,
   agentId, ticketId ownership, source metadata or authenticated status from
   Foundry function arguments. Use same trusted scope for SSE replay.
4. P3 integration owner: create scopedIntentToolRepositories(db, scope,
   ticketId) per authorized ticket invocation and pass its three adapters
   into registerIntentTools. This routes tools to the new authorized fact,
   intent and catalog methods, preserving existing interfaces. Do not
   globally register a mutable per-request scope.
5. Customer acceptance: createCustomerMessage(scope, ticketId, requestId,
   text) durably commits message and event before acknowledging HTTP 202.
   Existing requestIds return duplicated=true without a new event.
6. Foundry adapter: use ConversationContinuityRepository.get/bind/advanceCursor
   to persist the external provider conversation ID and compare-and-swap
   response cursor. Continue the same provider conversation on reconnect.
   This table holds no SDK calls, tokens or Foundry secrets. Then use
   createAssistantMessage(scope, ticketId, requestId,
   text, verifiedSourceReferences) only after validation. Source references
   must be passed from actual Foundry output; the DB deliberately does not
   fabricate or independently verify citations.
7. SSE: listAfter(scope, ticketId, Last-Event-ID, limit) yields monotonically
   ordered persisted ticket events. Replay the DB before Redis fanout.
8. Explicit action approval owner: authorize/preflight the operation and
   customer consent BEFORE enqueueAuthorizedOperation; use a stable
   idempotency key. This P2 repository only records the outbox transaction,
   never dispatches n8n itself.
9. Ticket closure owner: only pass confirmedCustomerClosure=true after
   verified customer confirmation and after resolving in-flight operations.
   The repository does not implement business-operation state machines.

The ticket's pinned agent_version_id and both catalog version foreign keys
must be passed into the conversation/tool scope. No auto-switch to current
catalog revision when continuing an existing ticket.

## Manual disposable database smoke checklist

- Apply migrations 001/002, P0 role bootstrap, then 003/004/005 with ON_ERROR_STOP=1.
- Seed two agents with active, published versions and published intent and
  offering catalogs; create one verified account in each agent.
- Login using agent_runtime, not postgres. Confirm SELECT without
  SET LOCAL app.agent_id returns zero scoped rows.
- In agent A transaction, insert/read an authorized ticket and message; verify
  the same IDs are invisible under agent B. Test both SELECT and UPDATE.
- Test foreign-key rejection for cross-agent ticket/message/fact references.
- Repeat identical customer requestId: same messageId and exactly one
  message.accepted event. New request IDs produce increasing message_sequence.
- Append two events, query after the first sequence, and ensure only the
  second is returned. Repeat an outbox key and ensure one row/event.
- Correct a fact from a second customer message, confirm old/new provenance
  is present in ticket_fact_events.
- Bind a provider conversation; reject rebinding to a different conversation
  and reject a stale compare-and-swap response cursor.
- Expire guest session and verify ticket access is denied. Upgrade ticket
  after verified account authentication and confirm the old guest token
  cannot read the account-linked ticket.

These are validation instructions, NOT claims that the checks passed.
