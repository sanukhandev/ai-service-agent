# ANCFZ 2Checkout mock payment and TEST invoice runbook

**Status:** The Node and n8n code implements the documented 2Checkout mock Orders POST and GET flows, agent/ticket-scoped OTP, immutable quote/payment state, provider evidence checks and private TEST invoice rendering. Everything is **disabled by default** until configured and smoke-verified against the merchant sandbox. No live gateway response has been tested.

## API documented by the merchant

- Base: https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/
- POST creates an order, returning RefNo, OrderNo, ExternalReference, Currency, GrossPrice and redirect_url (or PaymentDetails.PaymentMethod.RedirectURL).
- GET orders/{id}/ queries status. The documented Status values include COMPLETE, PENDING, DECLINED and REFUNDED.
- Authenticate with the saved private n8n HTTP Header Auth credential **X-Avangate-Authentication**.
- The provider's redirect callback and webhook event are **notifications only**. The webhook's SHA-256 signing formula was not provided; never accept a callback as payment confirmation. Node invokes the authenticated GET from the backend and independently matches the stored order reference, external reference, quotation ID, amount and currency.

**Return URL configuration:** The merchant settings currently show no default redirect URL. For an isolated localhost POC, set the gateway default redirect to http://localhost/ so the browser returns to Sara after the hosted simulation. This redirect is navigation only; click **Verify status with gateway** in the customer UI to perform the authenticated GET. Do not treat redirect query parameters as payment evidence or expose localhost POC endpoints publicly.

**Live validation blockers:** The docs show a USD example, while ANCFZ quotations currently use AED. Verify AED support before enabling Node payment dispatch. The GET path placeholder is described as payment_id but the POST response returns RefNo/OrderNo; confirm which provider ID the GET endpoint accepts. These are provider behavior questions, not reasons to fabricate payment success.

## Security and required credentials

The old ANCFZ merchant credential record **ANCFZ - MockGateway Demo X-API-Key** retains its UUID and name for safe migration of an already-seeded owner workspace. Edit the EXISTING credential in the n8n UI:

- Header name: X-Avangate-Authentication
- Header value: your **new, rotated merchant secret**, entered only in n8n

The previous X-API-Key and X-Guest-ID integration is obsolete. Never reimport credentials.template.json over your existing credential records; importing with the same ID can overwrite saved secrets.

Keep the existing shared private webhook Header Auth (X-ANCFZ-Workflow-Key) aligned with ANCFZ_N8N_WEBHOOK_SECRET, and keep N8N_ENCRYPTION_KEY unchanged. Do not paste secret values in Git, chat or logs.

## Upgrade the two already-seeded workflows

The new 03 and 04 JSON files are not automatically installed by a Git pull. Update ONLY those two existing workflows through the guarded script; do not rerun the original owner seed.

1. Back up/export the existing workflow definitions in your private n8n editor (not into Git). Verify the two payment workflows are inactive.
2. Pull the reviewed branch/main and restart n8n to refresh the read-only mounted workflow files.
3. Supply N8N_API_KEY privately in the PowerShell session, then run:

    node scripts/upgrade-n8n-2checkout.mjs --dry-run
    node scripts/upgrade-n8n-2checkout.mjs --inspect
    node scripts/upgrade-n8n-2checkout.mjs --apply
    node scripts/upgrade-n8n-2checkout.mjs --inspect

The upgrader refuses active/duplicated or unexpectedly modified workflow topology; it calls n8n public GET/PUT workflow endpoints, keeps workflow IDs and inactive states, and does not touch stored credentials, owner users or Docker volumes. A partial upgrade may be inspected and resumed after resolving the cause.

## Test-mode configuration

Set the following in the existing private local .env, using fresh, independent secrets. Do not enable on a public server.

    APP_ENV=development
    ANCFZ_OTP_MOCK_ENABLED=true
    ANCFZ_TEST_OTP_ENABLED=true
    ANCFZ_PAYMENT_DISPATCH_ENABLED=false
    ANCFZ_OTP_PEPPER=<new random 32+ character private value>
    ANCFZ_N8N_WEBHOOK_SECRET=<same 32+ character shared value used by n8n>

The Node flags are passed through Docker Compose. A valid token is entered ONLY into the n8n merchant Header Auth credential. Node never handles that merchant secret. Keep payment dispatch disabled until the provider's AED support and order-id lookup are tested using synthetic data.

    docker compose --profile workflows up -d n8n gotenberg
    docker compose up -d --build api
    node scripts/check-ancfz-billing-workflows.mjs
    node scripts/check-p5-2checkout.mjs

The Node script requires compiled API dist; run npm install and npm run build before calling it on a fresh checkout.

## Customer-owned API contracts

Every route requires the existing server-verified guest cookie and ticket ownership; mutating routes check the browser origin. These routes are NOT Foundry model tools.

1. POST /api/v1/tickets/:ticketId/payments/otp
   Body: requestId (new UUID), quotationId, acceptedAmount (exact two-decimal string from approved quote), currency AED, email in @example.invalid, firstName, countryCode AE, consent true and consentText equal to the literal PAYMENT_CONSENT constant in services/api/src/runtime/payment-evidence.ts.
   Node checks the durable verified quotation and PDF, limits issuance to five requests/hour per ticket and one per minute, generates a cryptographic six-digit code, stores only a pepper-keyed HMAC and requests delivery to the existing n8n Data Table mock. The code is NOT returned in the API. The owner can see this synthetic code in ANCFZ_POC_OTPS.
2. POST /api/v1/tickets/:ticketId/payments/authorize
   Body: new requestId, quotationId, challengeId from previous response, code (six digits), consent true, consentText. Node verifies challenge TTL, max five failed attempts and exact quotation linkage; it consumes the challenge once and inserts a durable one-shot payment outbox event.
3. GET /api/v1/tickets/:ticketId/payments
   Returns safe payment state and checkout URL (when the genuine gateway returns one). No secrets or OTP values.
4. POST /api/v1/tickets/:ticketId/payments/:paymentId/verify
   Calls the fixed n8n private verifier which issues a fresh authenticated 2Checkout GET. Only a matched terminal COMPLETE becomes verified_test_payment. Pending/declined/refunded/mismatch never authorize invoice creation.
5. GET /api/v1/tickets/:ticketId/invoices/:invoiceId/pdf
   Requires ticket ownership and a stored, bounded PDF rendered only after a matching verified TEST payment.

Node invoice and order workers run from durable outbox records with leases. An uncertain POST never gets blindly replayed (to avoid duplicate orders); a GET status check may be retried since it is read-only. Each quote can generate at most one payment attempt and invoice.

## Safe local smoke tests

After configuring the private n8n Header Auth credential, ensure the quotation and status-verifier workflows are active, then run:

    node scripts/test-ancfz-billing-webhooks.mjs --quotation

Expected: valid generated synthetic quotation PDF.

The previous negative test script for the old fail-closed stub is no longer applicable: the 2Checkout verifier now performs a real GET. Do not run a status verification test until the merchant token and GET identifier contract are configured.

## Live verification scenarios

Only enable ANCFZ_PAYMENT_DISPATCH_ENABLED=true after the merchant key has been rotated/configured and the following checks pass on synthetic IDs:

- AED quote support; POST order returns real RefNo, GrossPrice, Currency, ExternalReference, and trustworthy HTTPS checkout URL.
- GET by stored order reference succeeds and returns the corresponding identity and price.
- Pending and declined states never create paid invoices.
- A fresh GET with COMPLETE plus exact amount, currency, RefNo and ExternalReference creates ONE test invoice.
- Two repeated OTP attempts, duplicate payment authorization, expired OTP, wrong code and concurrent verification do not create duplicate orders/invoices.
- Cross-ticket invoice PDF download returns 404; webhook messages and redirect query strings never grant payment completion.
- All n8n workflow execution-data retention stays disabled for sensitive flows.

**This is a synthetic payment sandbox, not proof of receipt of actual funds.** Legal VAT, invoice numbering and real-world merchant settlement remain separate production work.
