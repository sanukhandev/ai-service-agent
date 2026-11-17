# ANCFZ 2Checkout mock payment and TEST invoice runbook

**Status:** The Node and n8n code implements the documented 2Checkout mock Orders POST and GET flows, agent/ticket-scoped OTP, immutable quote/payment state, provider evidence checks and private TEST invoice rendering. Everything is **disabled by default** until configured and smoke-verified against the merchant sandbox. No live gateway response has been tested.

## API documented by the merchant

- Base: https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/
- POST creates an order, returning RefNo, OrderNo, ExternalReference, Currency, GrossPrice and redirect_url (or PaymentDetails.PaymentMethod.RedirectURL).
- Live 17 November 2026 response: GET orders/{RefNo}/ queries status. The provider returned `ORDER_NOT_FOUND: No order found with RefNo ...` when passed an ANCFZ external reference. This differs from its written example using `{payment_id}`. The authenticated GET must confirm exact RefNo, ExternalReference, amount, currency and status before trust. COMPLETE, PENDING, DECLINED and REFUNDED are recognized.
- Authenticate with the saved private n8n HTTP Header Auth credential **X-Avangate-Authentication**.
- The provider's redirect callback and webhook event are **notifications only**. The webhook's SHA-256 signing formula was not provided; never accept a callback as payment confirmation. Node invokes the authenticated GET from the backend and independently matches the stored order reference, external reference, quotation ID, amount and currency.

**Return URL configuration:** The merchant settings currently show no default redirect URL. For an isolated localhost POC, set the gateway default redirect to http://localhost/ so the browser returns to Sara after the hosted simulation. This redirect is navigation only; click **Verify status with gateway** in the customer UI to perform the authenticated GET. Do not treat redirect query parameters as payment evidence or expose localhost POC endpoints publicly.

**Live validation blockers:** The docs show a USD example, while ANCFZ quotations currently use AED. Verify AED support before enabling Node payment dispatch. Live GET uses RefNo/OrderNo, while the dashboard also exposes an internal transaction UUID. The backend stores both separately; only RefNo is used in the GET URL. The internal ID is operator recovery metadata and must never replace RefNo in that URL. If the link is missing, recover the existing order by verified GET, not a new POST. These are provider behavior questions, not reasons to fabricate payment success.

## Security and required credentials

The old ANCFZ merchant credential record **ANCFZ - MockGateway Demo X-API-Key** retains its UUID and name for safe migration of an already-seeded owner workspace. Edit the EXISTING credential in the n8n UI:

- Header name: X-Avangate-Authentication
- Header value: your **new, rotated merchant secret**, entered only in n8n

The previous X-API-Key and X-Guest-ID integration is obsolete. Never reimport credentials.template.json over your existing credential records; importing with the same ID can overwrite saved secrets.

Keep the existing shared private webhook Header Auth (X-ANCFZ-Workflow-Key) aligned with ANCFZ_N8N_WEBHOOK_SECRET, and keep N8N_ENCRYPTION_KEY unchanged. Do not paste secret values in Git, chat or logs.

## Upgrade the three already-seeded workflows

The updated 02, 03 and 04 JSON files are not automatically installed by a Git pull. Update ONLY these three existing invoice/payment workflows through the guarded script; do not rerun the original owner seed.

1. Back up/export the existing workflow definitions in your private n8n editor (not into Git). Verify the three billing workflows are inactive.
2. Pull the reviewed branch/main and restart n8n to refresh the read-only mounted workflow files.
3. Run the Windows operator script (prompts privately for the owner API key):

    .\scripts\update-n8n-2checkout.ps1
    .\scripts\update-n8n-2checkout.ps1 -BackupOnly
    .\scripts\update-n8n-2checkout.ps1 -Apply

The default mode inspects without writes. -BackupOnly saves the three existing definitions outside the repository under the current user's home directory. -Apply re-inspects, creates an additional timestamped private backup, and updates all three workflows using snapshot hashes. It refuses a changed workflow, unexpected credential binding or unknown invoice-template customization. The owner must confirm with UPDATE 2CHECKOUT. All workflows remain inactive. This does not touch any saved n8n credential or the encryption key.

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

## Required MockGateway settings and unknown-outcome recovery

The MockGateway configuration requires both a **webhook** and an HTTPS redirect
before checkout can finish reliably. The public notification receiver is:

    https://<current-public-Sara-origin>/api/v1/mockgateway/notifications

It responds HTTP 200 but **never changes a payment or invoice**. Since the
merchant's webhook signature algorithm has not been verified, callback contents
are untrusted. Use the exact currently reachable HTTPS public Sara origin
(for local dev tunnels this address changes). The **default redirect URL** is
that same Sara origin followed by `/`. A redirect never proves payment.

The merchant's integration example expects
`X-Avangate-Authentication` in its saved n8n Header Auth credential, not the
obsolete `X-API-Key`. Check MockGateway's selected API Authentication setting
and a fresh read-only GET before sending another POST. A 401 is a credential
or authentication configuration failure, **not** evidence that the order was
never created. Never post merchant secrets or gateway response bodies in logs.

The one-shot Node order worker records a finite diagnostic code in
`ticket_payment_attempts.provider_status` when it cannot validate the POST
result: `n8n_http_<status>`, `n8n_timeout`, `n8n_response_not_json`,
`post_order_identity_mismatch`, `post_order_price_mismatch`,
`post_order_reference_invalid`, or `post_checkout_contract_invalid`.
This applies to **new** attempts only; old `post_result_unverified` rows
remain unchanged. Error codes do not prove the provider did not create an order.

To stop new outgoing payment POSTs during a provider outage, set
`ANCFZ_PAYMENT_DISPATCH_ENABLED=false` and recreate the API container. The
read-only payment status verifier remains available in development when the
private n8n webhook credential is configured. Do not delete the dead outbox.

For a ticket whose payment is already `unknown_outcome`:

1. Look up the **existing** order on MockGateway and obtain **both** its
   `RefNo`/`OrderNo` and its dashboard internal transaction ID; RefNo is the live GET key.
   They identify different fields. Only use a payment ID linked to the existing order.
2. In Sara's secure transaction controls, select **Reconcile existing order
   (GET only)** and enter both provider identifiers. This uses
   `POST /api/v1/tickets/:ticketId/payments/:paymentId/reconcile` as a
   ticket-owner-authorized **read-only provider GET**. The HTTP route is POST
   only to submit an operator-supplied reference; it never creates an order.
3. The server GETs by RefNo and matches provider RefNo, external reference, ticket, quotation,
   amount, currency and supported status before attaching the reference to the
   original payment. Failed recovery lookups count toward a maximum of five
   with a 60-second cooldown. No invoice is generated by reconciliation.
4. A subsequent authenticated gateway GET through **Verify status with gateway**
   (or automatic polling) advances to `payment_pending` or
   `verified_test_payment`. Only a fresh, independently matched COMPLETE
   can queue a TEST invoice.

If no genuine order exists, or the merchant cannot perform an authenticated
GET, keep the record `unknown_outcome`. Never create a duplicate order by
manually replaying the original payment outbox or OTP.

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
- GET by stored RefNo succeeds and returns that RefNo, identity and price.
- Pending and declined states never create paid invoices.
- A fresh GET with COMPLETE plus exact amount, currency, RefNo and ExternalReference creates ONE test invoice.
- Two repeated OTP attempts, duplicate payment authorization, expired OTP, wrong code and concurrent verification do not create duplicate orders/invoices.
- Cross-ticket invoice PDF download returns 404; webhook messages and redirect query strings never grant payment completion.
- All n8n workflow execution-data retention stays disabled for sensitive flows.

**This is a synthetic payment sandbox, not proof of receipt of actual funds.** Legal VAT, invoice numbering and real-world merchant settlement remain separate production work.

## November 2026: POST / GET identifier separation

The merchant's written guide calls the GET key `{payment_id}`, but the live
`ORDER_NOT_FOUND` error identifies that key as `RefNo`. The verified integration
calls `GET /rest/6.0/orders/{RefNo}/` and requires the returned RefNo to match. Migration `015_mockgateway_provider_payment_id.sql`
adds `provider_payment_id` without modifying existing attempts, consent,
quoted amounts, invoices or order references. The HTTP status worker now
requires both RefNo and dashboard transaction ID for recovery tracking; only
RefNo is placed in the GET URL. Missing fields fail closed.

For orders with a trusted HTTPS checkout URL of the exact form
`https://mockgateway.com/pg/pay/{payment_id}`, Node extracts the path token
as a candidate payment ID. This is inferred from the provided API examples,
not a substitute for independent GET verification: the gateway's response
must also match RefNo, external reference, exact AED amount and currency.
If the URL is absent or the payment ID cannot be verified, the operation
remains pending/unknown until an operator recovers both identifiers.

To confirm the merchant credentials and identifier **without creating a
new order**, run this script against an existing RefNo after
rotating the exposed key:

    .\scripts\check-mockgateway-order-readonly.ps1 -OrderReference "<existing RefNo>" -ExpectedExternalReference "<ANCFZ external ref>" -ExpectedAmount "20700.00"

The script prompts for the rotated secret without printing it, performs **one
GET** and displays only whether the reference, amount and currency match.
A 401 means merchant authentication remains invalid; a 404 means the selected
RefNo did not resolve. Neither error authorizes a POST retry.

Before using the new contract, import the forward-only migration, rebuild
API + web, and update the already-imported n8n **Order Create** and
**Payment Verification** workflows with the guarded `update-n8n-code-hotfix.ps1`
script. The upgrader now snapshots three workflows (including Salesforce)
and refuses to change active/published workflows or credentials.

**Auth outage:** The n8n log confirmed an HTTP 401 with invalid merchant
header authentication. Rotate the previously disclosed secret, then update
the existing saved n8n Header Auth credential using the merchant-specific
`X-Avangate-Authentication` header. Do not insert merchant secrets into
Node environment variables, URLs, scripts or chat messages. The public
MockGateway simulator does not use the HMAC format from the real 2Checkout
commerce API; use the mock merchant's documentation.

For the existing unknown-outcome ticket, query the payment row and n8n logs
read-only before recovery; never reset the original outbox or issue another
POST. Webhook and redirect notifications are not independent evidence of
`COMPLETE`. Only a subsequent authenticated GET authorizes the TEST invoice.

### Live 17 November 2026 pending order and exhausted lookup limit

For ticket `caf9406a-ab25-44f9-bf81-1ff9357f34a4`, the provider dashboard
shows one existing AED 30,150 PENDING transaction. Its actual RefNo and
internal transaction ID must be entered into the two recovery fields, in that
order, and must **never** be confused with the ANCFZ external reference.

The provider's POST response triggered `2Checkout external reference mismatch`.
The request metadata recorded by the dashboard alone does NOT establish that
the provider's authenticated GET returns that same external reference. Do not
relax this matching check, fabricate an external reference in the n8n response,
reset the original dead outbox, or infer COMPLETE from PENDING. First probe an
existing RefNo through authenticated GET and inspect only returned RefNo,
ExternalReference match, gross AED amount and provider status.

Customer reconciliation has a strict 5-lookup budget and a 60-second cooldown.
An exhausted lookup budget does not reset with time. Any recovery budget reset
must be privileged, one-shot, scoped to the exact payment after confirmed
provider identity, and must not create an order or invoice. Do not use a
customer-provided value alone to bypass that limit.
