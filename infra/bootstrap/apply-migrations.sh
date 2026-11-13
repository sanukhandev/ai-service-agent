#!/bin/sh
# Explicit migration-owner entrypoint for fresh AND existing PostgreSQL volumes.
set -eu
: "${PGHOST:?}"
: "${PGDATABASE:?}"
: "${PGUSER:?}"
: "${PGPASSWORD:?}"
: "${FOUNDRY_PROJECT_ENDPOINT:?Set FOUNDRY_PROJECT_ENDPOINT}"
: "${FOUNDRY_AGENT_NAME:?Set FOUNDRY_AGENT_NAME}"
: "${FOUNDRY_AGENT_VERSION:?Set FOUNDRY_AGENT_VERSION}"

psql -v ON_ERROR_STOP=1 -c "
 CREATE TABLE IF NOT EXISTS public.schema_migrations (
   name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
 );"


# Explicitly reconcile P2 databases that manually ran 003–005 before the
# migration ledger existed. Every adoption checks representative full schema,
# privileges and RLS. A partial preexisting migration still fails closed.
preapplied() {
  case "$1" in
    003_conversation_persistence.sql)
      psql -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='intent_catalog_version_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='offering_catalog_version_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tickets' AND column_name='last_message_sequence')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ticket_messages' AND column_name='message_sequence')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='event_outbox' AND column_name='idempotency_key')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ticket_fact_events' AND column_name='old_verification_status')
  AND to_regclass('public.ticket_messages_ordered_unique') IS NOT NULL
  AND to_regclass('public.ticket_intents_one_active_per_ticket') IS NOT NULL
  AND to_regclass('public.event_outbox_idempotency_unique') IS NOT NULL
THEN 'adopt' ELSE 'apply' END;
SQL
      ;;
    004_runtime_role.sql)
      psql -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname='agent_runtime' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls)
  AND has_table_privilege('agent_runtime','ticket_messages','INSERT')
  AND has_table_privilege('agent_runtime','ticket_fact_events','SELECT')
  AND NOT has_table_privilege('agent_runtime','agent_accounts','UPDATE')
THEN 'adopt' ELSE 'apply' END;
SQL
      ;;
    005_model_conversation_continuity.sql)
      psql -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT CASE WHEN
  to_regclass('public.ticket_model_sessions') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ticket_model_sessions' AND column_name='external_conversation_id')
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='ticket_model_sessions' AND column_name='last_response_id')
  AND EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.ticket_model_sessions') AND relrowsecurity AND relforcerowsecurity)
  AND has_table_privilege('agent_runtime','ticket_model_sessions','INSERT')
THEN 'adopt' ELSE 'apply' END;
SQL
      ;;
    *)
      printf '%s\n' apply
      ;;
  esac
}

for file in /migrations/003_conversation_persistence.sql /migrations/004_runtime_role.sql /migrations/005_model_conversation_continuity.sql /migrations/006_runtime_turns.sql /migrations/007_authorized_lead_operations.sql; do
  name=$(basename "$file")
  checksum=$(sha256sum "$file" | cut -d ' ' -f 1)
  current=$(psql -At -v ON_ERROR_STOP=1 -v file_name="$name" <<'SQL'
SELECT checksum FROM public.schema_migrations WHERE name = :'file_name';
SQL
)
  if [ -n "$current" ]; then
    if [ "$current" != "$checksum" ]; then
      echo "Migration checksum changed: $name (database=$current, source=$checksum)" >&2
      exit 1
    fi
    echo "Verified migration: $name"
    continue
  fi

  if [ "$(preapplied "$name")" = "adopt" ]; then
    psql -v ON_ERROR_STOP=1 -v file_name="$name" -v file_sum="$checksum" <<'SQL'
INSERT INTO public.schema_migrations(name,checksum) VALUES(:'file_name',:'file_sum');
SQL
    echo "Adopted verified pre-ledger P2 schema: $name"
    continue
  fi

  # The source migrations already contain their own BEGIN/COMMIT. Remove ONLY
  # those boundary lines so DDL and the checksum ledger commit atomically.
  temp=$(mktemp)
  {
    printf 'BEGIN;\n'
    sed -e '/^BEGIN;[[:space:]]*$/d' -e '/^COMMIT;[[:space:]]*$/d' "$file"
    printf '\nINSERT INTO public.schema_migrations (name, checksum) VALUES (\047%s\047, \047%s\047);\nCOMMIT;\n' "$name" "$checksum"
  } > "$temp"
  if ! psql -v ON_ERROR_STOP=1 -f "$temp"; then
    rm -f "$temp"
    echo "Migration failed; entire transaction rolled back: $name" >&2
    exit 1
  fi
  rm -f "$temp"
  echo "Applied migration: $name"
done

psql -v ON_ERROR_STOP=1 \
  -v foundry_endpoint="$FOUNDRY_PROJECT_ENDPOINT" \
  -v foundry_name="$FOUNDRY_AGENT_NAME" \
  -v foundry_version="$FOUNDRY_AGENT_VERSION" \
  -f /scripts/seed-sara.sql

echo "P3 migrations and Sara bootstrap completed without resetting PGDATA"
