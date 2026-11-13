# ANCFZ n8n import pack (P4)

**Status:** importable workflow templates; inactive and not yet connected to Node. No workflows have been deployed or live-tested against Salesforce, MockGateway, Gotenberg or SMTP. **Do not activate these in a shared environment before the security and provider validation listed below.**

This pack is intentionally **ANCFZ-specific**. The core agent-centric Node/PostgreSQL platform remains reusable, but these workflow names, Salesforce fields, invoice copy, gateway and verification rules belong only to the `ancfz` agent.

## Import order

Use n8n's **Import from File** for each JSON:

| File | Private webhook | Job |
|---|---|---|
| `00-otp-email.json` | `POST /webhook/ancfz/otp-email` | Deliver a **Node-generated** OTP via configured SMTP |
| `01-salesforce-lead.json` | `POST /webhook/ancfz/salesforce-lead` | Salesforce OAuth Lead upsert and provider ID readback |
| `02-render-pdf.json` | `POST /webhook/ancfz/render-pdf` | Quotation and invoice PDF via internal Gotenberg |
| `03-mockgateway-payment-link.json` | `POST /webhook/ancfz/payment-link` | MockGateway hosted **test** payment URL |
| `04-mockgateway-payment-verify.json` | `POST /webhook/ancfz/payment-verify` | Independent server-to-server verify |

Webhook nodes use n8n **Header Auth** and will be unable to run until a real header credential is attached to every imported workflow. Configure separate credential access for Salesforce OAuth, SMTP and MockGateway bearer authorization in the relevant downstream nodes. **Do not put API keys into JSON or git.**

These are **private server-to-server paths**: reachable through Docker `http://n8n:5678/webhook/...`, never via Nginx public routes. Attach a restricted shared Header Auth credential and call the endpoints from the authorized Node outbox worker only.

`docker compose --profile workflows up -d n8n gotenberg` starts n8n and an internal-only Gotenberg container. n8n editor requires local private access. Don't add public `ports:` to n8n or Gotenberg.

## Required n8n environment

- `SALESFORCE_INSTANCE_URL`: your Salesforce instance origin, e.g. `https://mydomain.my.salesforce.com`, no trailing slash.
- `MOCKGATEWAY_SLUG`: gateway slug created **in your MockGateway account**, not the public demo slug.
- `ANCFZ_OTP_FROM_EMAIL`: sender identity verified/configured in your SMTP provider.
- `N8N_ENCRYPTION_KEY`: private, persistent value set in `.env`.

**Salesforce dependency:** provision `Lead.ANCFZ_Ticket_ID__c` as a unique External ID field, storing Node ticket UUID. The workflow uses idempotent `PATCH /sobjects/Lead/ANCFZ_Ticket_ID__c/{ticketId}` and reads back the resulting Lead ID. Map additional ANCFZ qualification fields only after Salesforce schema validation.

**MockGateway dependency:** create a sandbox payment gateway, then download the gateway-generated Postman collection and verify the exact `init`, `verify` request/response formats. Current templates use `/api/pg/{slug}/init` and `/verify/{paymentId}`. The response normalization expects `payment_id`/`payment_url` or their documented alternatives. If the selected template changes the field names, modify **both** workflows together after integration testing. For this pack, `amount` is an integer in the mock template's configured currency unit; do not round formal amounts to fit.

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

Run locally: `node scripts/check-ancfz-workflows.mjs`. This validates JSON structure, required nodes and disabled state; it does **not** validate real n8n credential binding or provider execution.

Test the complete live paths with disposable sandbox identities: Salesforce duplicate request, SMTP rejection, OTP reuse/expiry, stale quote, MockGateway success/decline/pending/mismatch, PDF generation, duplicate callback, Node restart and private-document access controls.

Additional details: [ANCFZ workflow contract](../../../docs/ancfz-p4-workflow-contract.md).
