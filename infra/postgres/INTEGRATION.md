# Gemini persistence and migration integration

**Active branch:** `experiment/gemini-file-search-poc`. The numbered PostgreSQL migration chain is immutable and applied by `infra/bootstrap/apply-migrations.sh` with a checksum ledger.

## Schema and startup

- Fresh volumes initialize `001_core.sql`, `002_intents_and_ticket_facts.sql` and the restricted application role bootstrap.
- The one-off `migrate` service applies `003` through `020` in sequence, verifies hashes, then runs `infra/bootstrap/seed-sara.sql` to establish the version-pinned Sara Gemini example.
- Migrations `009`–`015` add Gemini model/source/session/evidence authority, immutable provenance, encrypted pending-function state and ingestion metadata. Migrations `016`–`020` add the optional ANCFZ synthetic purchase, OTP, payment/invoice, ID-document and service-request schema; their numbering avoids conflict with existing Gemini migrations.
- Earlier migrations include durable tickets, catalog and event/outbox structures still needed by Gemini.
- Existing columns with provider-neutral/historical names are not an active model integration. **Never edit or remove applied migration files**; use a reviewed new forward migration if actual schema retirement is required.

## Authorization and runtime credentials

Node connects using `PGUSER=agent_runtime` and `POSTGRES_APP_PASSWORD`, distinct from the migration owner's `POSTGRES_PASSWORD`. The runtime role must not be superuser or `BYPASSRLS`. All private agent queries use transaction-local agent scope plus ticket ownership checks. Preserve composite agent foreign keys and index coverage for conversations, sessions, source revocation and outbox.

## Session invariants

PostgreSQL is the authoritative source of session activity and expiry. Each accepted customer message advances the sliding 60-minute deadline; reconnects, Redis eviction and assistant messages do not. Expired AI sessions produce fresh conversations without cross-session model memory. The original ticket history stays accessible through the existing customer-authorization path.

Model-generated function continuation state is encrypted under an agent/session boundary, not a global reusable provider cursor. Material factual answer acceptance, evidence audit, assistant message persistence and event publication must remain in the same trusted transaction.

## Isolated acceptance

```bash
bash infra/postgres/gemini-p2-validate.sh
```

The validation script creates a **disposable, separately named Compose project**, checks fresh/repeated/checksum migration behavior, agent RLS/catalog publication, and real Node repository/HTTP/fake-model Gemini worker integration. It must never point at shared production or main application state. Never run `docker compose down -v` on an existing non-test project.

## Remaining certification

Passing the disposable database gate proves only the tested local persistence behavior. Live File Search document identity, real provider workflows, full multi-agent security and performance still require separate P6/G1 evidence. Consult [P7 status](../../docs/gemini-p7-status.md).
