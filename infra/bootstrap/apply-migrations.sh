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

for file in /migrations/003_conversation_persistence.sql /migrations/004_runtime_role.sql /migrations/005_model_conversation_continuity.sql /migrations/006_runtime_turns.sql; do
  name=$(basename "$file")
  checksum=$(sha256sum "$file" | cut -d ' ' -f 1)
  current=$(psql -At -v ON_ERROR_STOP=1 -v file_name="$name" -c "SELECT checksum FROM public.schema_migrations WHERE name = :'file_name'")
  if [ -n "$current" ]; then
    if [ "$current" != "$checksum" ]; then
      echo "Migration checksum changed: $name (database=$current, source=$checksum)" >&2
      exit 1
    fi
    echo "Verified migration: $name"
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
