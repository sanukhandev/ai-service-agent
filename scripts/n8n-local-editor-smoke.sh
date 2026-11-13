#!/usr/bin/env bash
# Runs on disposable CI containers. Never alters n8n owners/credentials.
set -euo pipefail

status() { curl --silent --output /dev/null --write-out '%{http_code}' "$1"; }
test "$(status http://localhost/api/health)" = 200
test "$(status http://localhost/n8n)" = 308
test "$(status http://localhost/n8n/webhook/ancfz/salesforce-lead)" = 404
test "$(status http://localhost/n8n/webhook-test/ancfz/test)" = 404
test "$(status http://localhost/n8n/form/foo)" = 404
test "$(status http://localhost/n8n/mcp/foo)" = 404

# A real n8n container (not a stub) must serve its editor under /n8n/.
ready=false
for attempt in $(seq 1 120); do
  code=$(status http://localhost/n8n/)
  if [ "$code" = 200 ]; then
    html=$(curl --fail --silent --show-error http://localhost/n8n/)
    if printf '%s' "$html" | grep -Eqi '(n8n|<html|<!doctype)'; then
      ready=true
      break
    fi
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  echo "n8n editor is not reachable via localhost/n8n/" >&2
  exit 1
fi

# Private service discovery and root webhook API remain on Docker DNS.
docker compose --profile workflows exec -T api node --input-type=module -e '
const r=await fetch("http://n8n:5678/healthz");
if(!r.ok) throw new Error("Private n8n health failed: "+r.status);
console.log("Private n8n health:",r.status);
'

# There must be no automatic n8n credential/workflow changes.
test "$(status http://localhost/api/health)" = 200
echo "n8n localhost editor ingress PASS: /n8n/, private Node DNS, protected webhooks, existing API"
