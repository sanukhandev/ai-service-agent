# ANCFZ P4/P5 — Authenticated business operations and 2Checkout mock billing

**Status:** Implementation exists on this feature branch; external Salesforce/2Checkout authorization, AED support, credential setup and live end-to-end acceptance remain unverified.

## Ownership matrix

| Component | Authority |
|---|---|
| Sara + Foundry IQ | Natural response, read-only business knowledge, optional function suggestions; never grants payment permission |
| Node Fastify | Verified guest/ticket scope, published catalog price, explicit customer consent, OTP challenge, durable payment attempt, independent gateway status evidence, invoice authorization |
| PostgreSQL | Agent-scoped durable quote/OTP/payment/invoice state, outbox idempotency, RLS and document bytes |
| n8n | Fixed private Header Auth webhooks to Salesforce, Gotenberg and 2Checkout mock provider |
| 2Checkout mock | Synthetic order creation, checkout and independent payment status; not evidence of real funds |

## Customer journey

1. Ticket and qualifying intent collected by Sara; Node persists the history.
2. Explicit consent for Salesforce Lead submission; Node dispatches and requires a verified 00Q... Lead reference.
3. Node selects a pinned, approved offering and exact price revision; n8n/Gotenberg renders a quotation PDF; Node validates magic/EOF, bounds, document number and ticket ID before saving privately.
4. Customer accepts the exact quotation amount and currency. Node issues a six-digit test OTP, stores only a keyed HMAC and requests synthetic delivery into n8n Data Table. Real mail delivery is NOT configured.
5. Customer enters the code in the customer-authenticated request. Node verifies a five-minute lifetime, one-time consumption, five-attempt limit and one-per-minute/five-per-hour rate limits. It stores a single payment attempt for the quotation and queues the order-create outbox record.
6. Node's outbox worker calls the private 2Checkout POST workflow exactly once, with a unique stable ExternalReference, immutable amount and billing details. A timeout becomes unknown_outcome, **not** a blind retry.
7. The provider returns RefNo/OrderNo plus optional redirect URL. Node parses but does **not** accept an order POST as payment proof.
8. A customer-owned payment verify endpoint calls n8n's authenticated GET /rest/6.0/orders/{id}/. Node accepts verified_test_payment **only** when fresh provider status COMPLETE and ID, external reference, currency, gross amount and quotation all match the authoritative payment record.
9. A verified test payment atomically queues a ticket-scoped invoice; the invoice worker requires the still-verified payment and renders a TEST invoice via the private Gotenberg workflow.
10. Node validates the invoice PDF, stores it under RLS and exposes only a ticket-owner-authorized PDF download.

## Gateway contract

The user-provided 2Checkout mock documentation specifies:

- POST https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/
- GET https://mockgateway.com/api/base/2checkout-fzucuq/rest/6.0/orders/{id}/
- Header **X-Avangate-Authentication** (merchant secret in private n8n credential, never Git).
- Request: Currency; Items[0].Price.UnitNetPrice; ExternalReference; BillingDetails.FirstName/Email/CountryCode; PaymentDetails.Type=CC.
- Create result: RefNo, OrderNo, ExternalReference, Currency, GrossPrice and redirect_url or PaymentDetails.PaymentMethod.RedirectURL.
- Verified status: Status COMPLETE, PENDING, DECLINED, REFUNDED; RefNo, ExternalReference, Currency, GrossPrice.

**Unknowns to verify live:** Does the GET endpoint accept the returned RefNo/OrderNo versus a different payment_id? Does the mock merchant support AED rather than the documented USD example? What exactly is signed to produce X-Mock-Signature? Until tested, do not claim paid orders or webhook authenticity.

The existing n8n credential ID is retained, but its old visible name is legacy. The operator must change the Header Auth name/value in the editor, and run the guarded updater for the two already-seeded payment workflows. Existing credentials and the persistent n8n encryption key must not be overwritten.

## Security and failure transitions

- All external actions are separate customer POST requests scoped by the secure guest session, not model tools.
- The Node payment/OTP route is explicitly development-only with opt-in environment flags and synthetic @example.invalid identities. Private/test values are not placed in chat messages or LLM context.
- Duplicate payment authorizations for a quote are rejected; a reused request ID returns the same attempt. OTPs are consumed once; unsuccessful guesses persist attempt counts.
- n8n HTTP 200, redirects, order_created, checkout_available and a customer's 'paid' statement never imply a paid invoice.
- A provider GET timeout, invalid JSON or correlation mismatch results in unknown_outcome; future GETs can be retried, while unconfirmed POSTs cannot be replayed automatically.
- Only verified COMPLETE generates an invoice. Pending, declined and refunded states block issuance. Existing verified invoices are labelled TEST and are not legal receipts.
- Native webhook signing is not enabled because the documented SHA-256 signing expression is missing. Customer redirects or webhook notifications may prompt a fresh server-side GET but are never authorization.
- Nginx publishes only 127.0.0.1:80; n8n, Gotenberg and PostgreSQL remain private Docker services.

## Acceptance tests

- Verified Salesforce Lead required for quotation; matching immutable catalog price required for every payment.
- Invalid, expired, reused OTP, duplicate authorization and altered amount/currency do not create a payment order.
- Unknown order POST outcome is quarantined; no blind duplicate order POST.
- Gateway returns real order ID and strictly trusted mockgateway.com HTTPS checkout URL.
- GET paid/declined/pending/refunded and mismatched RefNo/amount/currency/reference are tested.
- Exactly one verified sandbox invoice is stored; duplicate GET and customer refreshes do not produce duplicates.
- Cross-agent/cross-ticket read and invoice downloads fail under RLS and ticket ownership.
- Browser redirect/webhook spoofing does not create paid state.
- Live credentials and actual n8n/merchant execution remain separate acceptance gates from offline CI.

See [the operator runbook](../infra/n8n/ancfz/BILLING.md) for commands and configuration. No real-world financial settlement is proven by the mock gateway.
