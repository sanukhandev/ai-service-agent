# ANCFZ billing workflows — quotation, sandbox payment, and invoice

## Current capability and blocker

The existing Node P4 implementation can issue a ticket-owned quotation only after a verified Salesforce Lead and a published offering price. Node captures an immutable price revision, dispatches n8n/Gotenberg rendering, validates the returned PDF and stores it privately.

Payment-link and status workflows are already defined in n8n. The MockGateway demo Orders POST can create an order, but **order creation is not payment**. The matching **status retrieval endpoint and response schema are not documented** in the supplied materials. The existing verification workflow intentionally returns verification_unconfigured and verified:false. Node has no authoritative payment ledger, customer payment authorization flow or complete P5 OTP verifier yet.

**Do not activate provider payment collection or claim an invoice is paid until these dependencies are implemented and validated.**

## Sequence and trust boundary

1. Node verifies ownership, customer consent, published offering/price and a verified Salesforce Lead before generating a quotation.
2. n8n renders a quotation through private Gotenberg. Node independently checks PDF bytes, document number and ticket correlation, then stores the PDF.
3. A customer must explicitly approve the exact quotation amount and currency. Node must issue/verify a single-use OTP tied to that quote. The existing n8n Data Table mock is **not** an OTP verifier.
4. Only after durable Node authorization may an outbox worker request a MockGateway demo order through the existing /webhook/ancfz/payment-link path.
5. The demo Orders POST response must supply a genuine order identifier. If it also echoes amount, currency or external reference, n8n now verifies they match the Node-authorized request; it rejects contradictory values. It shares an HTTPS checkout URL only when the provider actually supplies one.
6. A customer statement or a successful order POST is not payment evidence. Independently query the *documented* status endpoint when available, then require a matched terminal paid response with provider ID, amount and currency.
7. Only then may Node create an invoice. The n8n template now rejects a bare paymentVerified flag: it also requires a correlated paymentEvidence structure from Node with status verified_test_payment, provider mockgateway_demo_orders, matching ticket/quote IDs, amount, currency and provider reference. These checks do not replace Node's own ledger verification.

## Offline checks (no network or provider activity)

From the repository root:

    node scripts/check-ancfz-workflows.mjs
    node scripts/check-ancfz-billing-workflows.mjs

The billing check executes Code-node logic using synthetic inputs and asserts HTML escaping, invoice rejection without evidence, amount/currency/correlation mismatch rejection, safe provider checkout URL handling, PDF packaging and payment-verification fail-closed behavior.

## Local PDF renderer acceptance (internal-only)

Run:

    docker compose --profile workflows up -d n8n gotenberg
    docker compose --profile workflows exec -T n8n node /workflows/ancfz/test-gotenberg.mjs

The Gotenberg test renders a synthetic quotation HTML directly through internal Docker DNS, verifies a bounded PDF and prints a small diagnostic. No real invoice, order, customer record or provider request is created. It requires APP_ENV=development in the n8n container.

## Existing private n8n workflow smoke

Ensure the Header Auth credential in n8n uses header name X-ANCFZ-Workflow-Key with the same private value as ANCFZ_N8N_WEBHOOK_SECRET on the host. Keep the secret out of chat, shell history and Git.

Activate the existing **ANCFZ | PDF Quotation or Invoice** workflow only after reviewing its credential binding. Then run:

    node scripts/test-ancfz-billing-webhooks.mjs --quotation

This calls the private webhook with synthetic data, checks the PDF response and prints only metadata. It does not authorize an invoice.

You may activate the existing **ANCFZ | MockGateway Demo Orders Status (Fail Closed Until Verified)** workflow for an isolated negative test, then run:

    node scripts/test-ancfz-billing-webhooks.mjs --payment-verify

Expected result is status verification_unconfigured and verified:false. This proves no paid event is fabricated; it is not an actual payment confirmation. Keep the order-creation workflow inactive until Node's OTP, approval and idempotency gates are built. The billing smoke never calls an order-create endpoint.

## Real demo checkout prerequisites

- A valid privately stored MockGateway demo X-API-Key credential and a matching MOCKGATEWAY_GUEST_ID.
- Actual demo Orders POST response examples showing the provider reference and any real checkout URL.
- Documented demo Orders retrieve/status endpoint and examples for paid, pending, declined and mismatched payments. Never guess a GET route or substitute unrelated /api/pg/{slug} endpoints.
- Node P5 secure OTP verification, exact-amount consent, payment attempt ledger, idempotent provider dispatch, safe unknown-outcome reconciliation, invoice persistence and ticket-scoped download authorization.
- Approved legal invoice identity, numbering, tax rules, terms, and live provider acceptance evidence.

## Updating an already-seeded n8n instance

The original five workflows are already imported in the owner's personal workspace. Source JSON changes in Git **do not automatically update** the live records. The seed script correctly refuses overwrites, including existing credentials.

Back up the existing workflows and encrypted n8n data before updating workflow definitions. Keep a single active workflow for each webhook path, preserve existing credential IDs/values and never reimport the credentials template over configured credentials. Update the invoice and order-response Code nodes from the reviewed source changes before live billing acceptance.

## Strict labels

- Quotation PDF: not an invoice and not proof of payment.
- Demo order: order_created/checkout_available at most; verified:false.
- Payment verifier: verification_unconfigured, verified:false until official provider status integration.
- Invoice: blocked until independently verified, matching **sandbox** payment in Node.
- No real funds are established by these workflows.
