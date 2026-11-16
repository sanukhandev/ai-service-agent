# ANCFZ n8n workflow pack

**Scope:** One agent (Sara), Node Fastify as the sole ticket/consent/payment authority, n8n as the private integration executor. Nothing in this directory should be exposed directly to the browser or the model. Keep the existing n8n encryption key and Docker volume.

## Guides

- [Owner workspace seeding and preservation](SEEDING.md): original four credential placeholders and five inactive workflows.
- [Synthetic OTP without SMTP](MOCK_OTP.md): test-only n8n Data Table delivery plus expiry cleanup.
- [2Checkout mock billing](BILLING.md): NEW merchant REST/6.0 endpoints, credential changes, guarded workflow upgrade, Node payment/OTP and TEST invoice.

## Workflow inventory

| Source file | Job | Webhook | Default |
|---|---|---|---|
| 00-otp-email.json | SMTP delivery of Node-issued OTP | /webhook/ancfz/otp-email | Inactive |
| 01-salesforce-lead.json | Authorized Salesforce Apex REST Lead | /webhook/ancfz/salesforce-lead | Inactive |
| 02-render-pdf.json | Gotenberg quotation or verified TEST invoice | /webhook/ancfz/render-pdf | Inactive |
| 03-mockgateway-payment-link.json | 2Checkout mock order creation, conditional hosted checkout URL | /webhook/ancfz/payment-link | Inactive |
| 04-mockgateway-payment-verify.json | Authenticated 2Checkout mock GET order status | /webhook/ancfz/payment-verify | Inactive |
| 05-mock-otp-table.json | LOCAL synthetic OTP delivery to n8n Data Table | /webhook/ancfz/otp-email | Inactive |
| 06-mock-otp-prune.json | LOCAL expired test-code cleanup | Scheduled | Inactive |
| 07-licence-renewal-lookup.json | Read-only exact lookup against ANCFZ_POC_LICENCES n8n Data Table | /webhook/ancfz/renewal-lookup | Inactive |

The new 2Checkout files intentionally retain the original file paths and fixed workflow/credential IDs for compatible upgrades. The two delivery workflows share the same OTP URL; **only one can be active**.

## Synthetic licence renewal setup

Follow [the dedicated renewal guide](../../../docs/ancfz-licence-renewal.md)
to create the synthetic Data Table, import the new workflow and publish
explicitly approved TEST renewal prices. The existing PDF, payment and OTP
workflow definitions are reused; no n8n credential or volume is reset.

## Existing owner installation

The baseline n8n seed has already been imported into the owner's personal workspace. **A Git pull alone does not update the live 02 invoice, 03 order-create or 04 status-verification workflows**. Use the guarded three-workflow updater from [BILLING.md](BILLING.md), after deactivating all three workflows:

    .\scripts\update-n8n-2checkout.ps1
    .\scripts\update-n8n-2checkout.ps1 -Apply

Never reimport credential templates over configured credentials. The existing merchant credential's label remains **ANCFZ - MockGateway Demo X-API-Key** for stable ID compatibility; edit its actual Header Auth name to **X-Avangate-Authentication** and its value to a **rotated secret** in n8n's protected Credentials editor.

The previous merchant account endpoint under /api/v1/public/demo/base/ancfz-f6i0ry and the X-Guest-ID/X-API-Key headers are **retired**. New documented endpoints are:

    POST https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/
    GET  https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/{id}/

The docs show a USD example. ANCFZ quotations use AED: prove merchant AED compatibility and confirm whether GET accepts RefNo before activating payment dispatch.

## Updating the detailed quotation proposal (existing n8n installation)

`02-render-pdf.json` now renders the source-derived **package description,
customer requirements, published terms, exclusions, and next steps** for
quotations. Its existing invoice branch remains restricted to independently
verified TEST payments.

**Pulling Git or rebuilding containers does not update a workflow already
stored in n8n.** For a local development instance with an existing configured
PDF workflow:

1. Back up the existing `ANCFZ | PDF Quotation or Invoice` workflow using
   the authenticated n8n UI's Export command. Keep the backup private.
2. Deactivate the workflow temporarily; do not reset its credentials or
   replace the n8n data volume.
3. From the repository root in PowerShell, copy the reviewed JavaScript for
   only the `Prepare Escaped HTML` Code node:

   ```powershell
   $workflow = Get-Content '.\infra\n8n\ancfz\02-render-pdf.json' -Raw | ConvertFrom-Json
   ($workflow.nodes | Where-Object { $_.name -eq 'Prepare Escaped HTML' }).parameters.jsCode | Set-Clipboard
   ```

4. Paste this into the existing `Prepare Escaped HTML` Code node, save, and
   reactivate that same workflow. **Do not reimport credential templates,
   change workflow IDs/webhook paths, or update payment gateway workflows.**
5. Validate the local source and test a **new** synthetic quotation:

   ```powershell
   node scripts/check-ancfz-billing-workflows.mjs
   node scripts/check-p4-quotation.mjs
   ```

   The second command expects a compiled Node API (`npm run build` from the
   API workspace). Offline tests do not validate the actual live n8n workflow.
   Confirm the generated PDF shows requirements and published package scope.
   Existing verified quotation PDFs are immutable and are not regenerated.

## Auth and business boundaries

- n8n webhooks require a private Header Auth credential with **X-ANCFZ-Workflow-Key** matching Node's ANCFZ_N8N_WEBHOOK_SECRET. All callbacks are internal Docker backend-only.
- Salesforce uses private OAuth2 Client Credentials against the sandbox custom Apex REST endpoint; no static token or client secret is committed.
- Mock OTP stores **synthetic test codes** with five-minute expiry. Node holds the authoritative pepper-keyed OTP digest, max five failed attempts, rate limits and single-use authorization.
- Node requires a verified Salesforce Lead and published offering price before quotation. Node's payment outbox can run only after quote-specific customer consent and test OTP verification.
- 2Checkout's initial order response is not payment evidence. Node separately queries the status workflow, requires matched COMPLETE/RefNo/ExternalReference/GrossPrice/Currency and only then queues a TEST invoice.
- A redirect or webhook is never independent payment proof. The documented webhook SHA-256 formula is incomplete, so webhook signatures are **not** accepted as authorization.
- Unknown external POST outcomes stay unknown rather than being automatically replayed. Mock checkout is not a live receipt of real funds.

## Local verification

    node scripts/check-n8n-anzfc-seed.mjs
    node scripts/check-ancfz-credentials.mjs
    node scripts/check-ancfz-workflows.mjs
    node scripts/check-ancfz-billing-workflows.mjs
    node scripts/check-2checkout-upgrade.mjs

After compiling the API:

    node scripts/check-p5-2checkout.mjs

These are **offline contract checks**; success does not prove external gateway functionality. Run local n8n/Gotenberg and authenticated provider tests separately after configuring private credentials.

**Security:** n8n and Gotenberg must never publish host ports. Do not reset n8n volumes, rotate an already-used N8N_ENCRYPTION_KEY or commit sensitive provider payloads.
