# ANCFZ n8n import pack (P4)

**Status:** importable workflow templates; inactive and not yet connected to Node. No workflows have been deployed or live-tested against Salesforce, MockGateway, Gotenberg or SMTP. **Do not activate these in a shared environment before the security and provider validation listed below.**

This pack is intentionally **ANCFZ-specific**. The core agent-centric Node/PostgreSQL platform remains reusable, but these workflow names, Salesforce fields, invoice copy, gateway and verification rules belong only to the `ancfz` agent.

## Credentials import (NEW — four reusable n8n credentials)

**Import credentials separately from workflow JSON.** n8n's workflow import does not install working credentials. The new `credentials.template.json` is a valid n8n CLI import array containing **placeholders only**. It covers:

| Credential | n8n type | Used by |
|---|---|---|
| ANCFZ - Node to n8n Webhook Header | `httpHeaderAuth` | All five inbound private webhook triggers |
| ANCFZ - Salesforce OAuth2 Sandbox | `salesforceOAuth2Api` | Salesforce Lead upsert and provider ID readback |
| ANCFZ - SMTP OTP Delivery | `smtp` | OTP Send Email node |
| ANCFZ - MockGateway Demo X-API-Key | `httpHeaderAuth` | Demo Orders HTTP Request; header `X-API-Key` |

Each node now has the **matching stable credential ID/name** in its workflow JSON. Import the credential pack **before** the workflows into the same n8n instance/project. Do not import the placeholder template and assume it is usable.

### Prepare a private import file (Node 22+)

Copy `credentials.env.example` to a **private file outside Git**, fill with new secrets, and use the generator. On Linux/macOS:

```sh
mkdir -p "$HOME/.config/ancfz"
cp infra/n8n/ancfz/credentials.env.example "$HOME/.config/ancfz/n8n-credentials.env"
chmod 600 "$HOME/.config/ancfz/n8n-credentials.env"
# Edit your private file; do NOT put real values in Git or shell history.
node --env-file="$HOME/.config/ancfz/n8n-credentials.env" \
  scripts/prepare-ancfz-credentials.mjs --output "$HOME/.config/ancfz/credentials-import.json"
```

Windows PowerShell (run inside the repository):

```powershell
Copy-Item infra/n8n/ancfz/credentials.env.example "$env:USERPROFILE\ancfz-n8n-credentials.env"
# Edit the private file and restrict its Windows file permissions.
node --env-file="$env:USERPROFILE\ancfz-n8n-credentials.env" scripts/prepare-ancfz-credentials.mjs --output "$env:USERPROFILE\ancfz-n8n-import.json"
```

The generator requires all four credential configurations, validates required fields, refuses output inside the repository, refuses overwrite and writes with owner-only permissions on POSIX systems. The generated JSON contains **plaintext secrets** until n8n encrypts them on import. Never attach this generated file to an issue, chat, PR or backup without encryption.

### Import into the private Docker n8n instance

First complete n8n owner account setup, ensure a **persistent nonempty** `N8N_ENCRYPTION_KEY` is configured in the local Compose `.env`, and start the workflow profile. On Linux/macOS, for the file generated above:

```sh
docker compose --profile workflows up -d n8n gotenberg
docker compose --profile workflows cp "$HOME/.config/ancfz/credentials-import.json" n8n:/tmp/ancfz-credentials.json
docker compose --profile workflows exec -T --user root n8n chown node:node /tmp/ancfz-credentials.json
docker compose --profile workflows exec -T n8n n8n import:credentials --input=/tmp/ancfz-credentials.json
docker compose --profile workflows exec -T n8n rm -f /tmp/ancfz-credentials.json
rm "$HOME/.config/ancfz/credentials-import.json"
```

On Windows use `docker compose --profile workflows cp "$env:USERPROFILE\ancfz-n8n-import.json" n8n:/tmp/ancfz-credentials.json`, then the same three `docker compose exec` commands; delete the local generated file with `Remove-Item` afterward. **Never copy the plaintext import into `/home/node/.n8n`**, the persistent n8n data volume.

n8n CLI `import:credentials` expects an **array** and preserves supplied IDs. **Reimporting into an instance with these IDs may overwrite its existing credentials.** Check for collisions and back up the n8n database/encryption key before importing to an existing instance. For a multi-user instance, use the CLI's `--projectId` ownership option.

### After importing

1. Open n8n Credentials in the protected editor connection and confirm the four credentials exist; replace any placeholders if the template was imported instead of using the generator.
2. **Salesforce OAuth2 requires clicking Connect/Authorize in n8n**. Client ID/secret import alone does **not** create access/refresh tokens. Configure the External Client App callback and reachability via a controlled private access path. Do not publicly expose n8n to solve the callback.
3. Verify SMTP with a safe test message, verify the private inbound Header Auth credential, and verify MockGateway's test key against the ANCFZ Orders endpoint.
4. Import the five workflow files (below), confirm every node resolves to the intended credential and leave all workflows **inactive** until Node authorization/OTP and provider acceptance are complete.

The MockGateway API key previously pasted in chat should be **rotated** before putting it into the private credentials store. `X-Guest-ID` comes from `MOCKGATEWAY_GUEST_ID` in the local Compose `.env` and is **not** the API key.

## Import order

Import each JSON via n8n UI over a private editor connection or the mounted CLI path (e.g. `docker compose --profile workflows exec n8n n8n import:workflow --input=/workflows/ancfz/03-mockgateway-payment-link.json`). The Docker network intentionally does **not** publish the editor to the host.

| File | Private webhook | Job |
|---|---|---|
| `00-otp-email.json` | `POST /webhook/ancfz/otp-email` | Deliver a **Node-generated** OTP via configured SMTP |
| `01-salesforce-lead.json` | `POST /webhook/ancfz/salesforce-lead` | Salesforce OAuth Lead upsert and provider ID readback |
| `02-render-pdf.json` | `POST /webhook/ancfz/render-pdf` | Quotation and invoice PDF via internal Gotenberg |
| `03-mockgateway-payment-link.json` | `POST /webhook/ancfz/payment-link` | MockGateway **demo Orders** request; only return a hosted test checkout link if the API response actually supplies one |
| `04-mockgateway-payment-verify.json` | `POST /webhook/ancfz/payment-verify` | Fail-closed order-status stub until the matching demo Orders verification endpoint is documented |

Webhook nodes use **Header Auth**. Their credential references are included in the workflow JSON, but actual values must be generated/imported privately. Salesforce OAuth, SMTP and MockGateway use the separate credentials listed above. **Do not put real API keys into checked-in JSON or Git.**

These are **private server-to-server paths**: reachable through Docker `http://n8n:5678/webhook/...`, never via Nginx public routes. Attach a restricted shared Header Auth credential and call the endpoints from the authorized Node outbox worker only.

`docker compose --profile workflows up -d n8n gotenberg` starts n8n and an internal-only Gotenberg container. n8n editor requires local private access. Don't add public `ports:` to n8n or Gotenberg.

## Required n8n environment

- `SALESFORCE_INSTANCE_URL`: your Salesforce instance origin, e.g. `https://mydomain.my.salesforce.com`, no trailing slash.
- `MOCKGATEWAY_GUEST_ID`: configure the demo guest UUID from the supplied example in your **local** `.env`; do not treat it as an authentication credential.
- `ANCFZ_OTP_FROM_EMAIL`: sender identity verified/configured in your SMTP provider.
- `N8N_ENCRYPTION_KEY`: private, persistent value set in `.env`.

**Salesforce dependency:** provision `Lead.ANCFZ_Ticket_ID__c` as a unique External ID field, storing Node ticket UUID. The workflow uses idempotent `PATCH /sobjects/Lead/ANCFZ_Ticket_ID__c/{ticketId}` and reads back the resulting Lead ID. Map additional ANCFZ qualification fields only after Salesforce schema validation.

**MockGateway demo Orders API (user-supplied contract):** The order-create template now calls `POST https://mockgateway.com/api/v1/public/demo/base/ancfz-f6i0ry/rest/6.0/orders/`. Use the **X-API-Key** as a privately stored n8n HTTP Header Auth credential, not an API key in Git, Node or workflow JSON. The request also sends `X-Guest-ID` from `MOCKGATEWAY_GUEST_ID` and `Content-Type: application/json`. Its body contains `Currency: "AED"`, `Items: [{ Price: { UnitNetPrice: "10.00" } }]` (the actual validated quotation amount), `ExternalReference`, `BillingDetails` and `PaymentDetails: { Type: "CC" }`. The sample price **must not** be used for real quotations. All amounts are fixed two-decimal strings from the immutable approved quote, rather than assumed integer cents.

**Critical provider gap:** An Orders POST is not inherently a payment-link creation or payment verification API. Until the **actual response** proves a hosted checkout URL exists, the workflow returns `order_created_checkout_unavailable` with no link. The supplied curl contains **no payment-status endpoint**, so `04-mockgateway-payment-verify.json` currently returns `verification_unconfigured`, `verified:false`; it never declares payment received. Before enabling, obtain the demo Orders response plus its status/retrieve API example or exported Postman collection. Do not substitute the unrelated generic `/api/pg/{slug}/verify` endpoint. Test amount/ID/currency matching independently in Node before invoice issuance.

**Credential handling:** If the supplied demo key is active and publicly exposed elsewhere, rotate it. Never paste it into version control. n8n's `N8N_ENCRYPTION_KEY` must be persistent for credential encryption. Store both it and the API key privately.

**PDF dependency:** Gotenberg receives an `index.html` binary and returns a PDF. n8n responds with `pdfBase64` and document metadata. Node must verify PDF magic bytes/size, checksum it, store it privately and expose a ticket-owner-authorized download endpoint. The generated HTML escapes user text but **production-grade branded templates, taxes, legal terms and genuine invoice numbering are not yet configured**. No tax or quote price is fabricated.

**OTP dependency:** Node, not n8n, creates/verifies OTP challenges. The email workflow **only delivers** the supplied code; it must not generate, validate, persist, publish or log OTPs. Disable execution retention (set to none in exports) and configure TLS/email delivery before using real identities.

## Required Node integration (not included in these templates)

1. ANCFZ agent-bound operation approval API and explicit customer consent. Use existing ticket owner authorization plus CSRF protection.
2. Durable operation proposal + immutable quoted price snapshot, outbox worker with safe leasing, dedupe and signed/internal dispatch.
3. Rate-limited hashed OTP challenge store, 5-minute expiry, send limit, retry limit, consume-once state and UI.
4. Provider evidence parsing and transitions: never mark Salesforce lead or payment as completed on HTTP 200 alone.
5. Private PDF storage, ticket-scoped document download, SSE operation events, invoice creation **only** after matching test-payment verification.
6. Integrate approval/payment controls into Next.js and live-test all failure paths.

Do not wire the model directly to the private webhooks. **The user saying "paid" is merely a trigger to query status, not proof of payment.**

## Smoke tests before enabling

Run locally: `node scripts/check-ancfz-workflows.mjs` and `node scripts/check-ancfz-credentials.mjs`. These validate structural JSON and credential ID bindings plus safe generation. They do **not** verify live OAuth authorization, imported-credential decryptability, Salesforce, SMTP, MockGateway, or provider execution.

Test with disposable identities: Salesforce duplicate request, SMTP rejection, OTP reuse/expiry, stale quote, demo Orders creation and real response fields, documented checkout flow, status success/decline/pending/mismatch, PDF generation, duplicate callback, Node restart and owner-scoped document access. If the demo endpoint has no checkout/status operation, it cannot satisfy the payment-and-invoice acceptance requirement.

Additional details: [ANCFZ workflow contract](../../../docs/ancfz-p4-workflow-contract.md).
