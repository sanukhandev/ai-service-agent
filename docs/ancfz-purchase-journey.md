# ANCFZ purchase journey — catalog, document intake, consent, OTP, order, invoice

## Scope and evidence status

The Sara/ANCFZ POC uses a ticket-pinned, versioned intent catalog. Revision 1
only permitted `create_lead` and `generate_quote` for `company_formation`.
The currently published intent catalog is cloned into an immutable revision
that requires exactly **passport** and **Emirates ID** for every intent.
The `purchase_quotation` action is published only for quote-enabled intents,
with a separately authorized `create_lead` prerequisite. Other identity or application documents are rejected. This is *not* a verified
list of all documents required by ANCFZ authorities. Obtain and publish an
approved checklist before using real identity information or customer funds.

The purchase flow does not run solely because the model detects an intent.
Only the authenticated ticket owner can upload required documents and
explicitly confirm purchase; only Node can initiate an OTP, validate it,
enqueue an order and independently verify provider evidence.

## Detailed quotation proposal (P4)

Before requesting the combined Salesforce/quotation authorization, Sara presents a
**non-binding, itemized proposal** containing the selected offering name/key,
exact price and term, the offering's published description, the customer's
persisted non-disputed business requirements, current price conditions, and
explicit limits. A customer's workspace preference is **not** an included,
priced desk/office upgrade unless the catalog description or conditions say so.
The package's published description, rather than model prose, defines what may
be described as included. No promise of licensing, visas, banking, or other
regulatory approval is inferred.

At quotation dispatch, Node snapshots these details from the ticket-pinned
offering revision and source-linked ticket facts into the authorized quote
outbox. The n8n Gotenberg renderer uses this trusted snapshot to include
**Package scope**, **Customer requirements**, **Published price conditions**,
**Scope/limitations** and **Next steps** within the quotation PDF, in addition
to the price line and total. The confirmed quotation message also summarizes
these details and links to the owner-only PDF.

The quotation remains non-binding and separate from purchase consent, OCR,
synthetic OTP and payment verification. This change does not overwrite PDFs
previously stored in PostgreSQL: it applies to **newly generated quotations**.
No migration is needed. On an already-seeded n8n instance, update only its
existing inactive *Prepare Escaped HTML* code node using the versioned source
`infra/n8n/ancfz/02-render-pdf.json`; see the workflow README. A Docker
image rebuild alone does not rewrite saved n8n workflows.

## Sequence

1. Model selects an active supported `company_formation` ticket intent.
2. Existing Node lead and quotation paths produce a verified, pinned-priced
   quotation PDF. A mere chat statement is not an approved quote.
3. Customer sees the configured private document checklist. The POC requires
   a synthetic passport bio-page and a synthetic Emirates ID.
   Only passport/Emirates ID PDF/PNG/JPEG files up to 1 MiB are accepted.
   A fixed Azure Document Intelligence `prebuilt-idDocument` model extracts
   the holder name from each upload. The names must match (ignoring token order),
   and only the normalized names and document-number last four characters
   are saved from the OCR output. The original bytes are persisted in `ticket_purchase_documents` with SHA256 and tenant-free
   agent/ticket-scoped RLS; raw bytes are never sent to Foundry or n8n.
   Extraction is not identity or document-authenticity verification. By default, if
   OCR cannot extract both full names, the upload is rejected and purchase remains blocked.
   For **synthetic local development only**, `APP_ENV=development` plus
   `ANCFZ_DEV_ACCEPT_UNNAMED_PASSPORT=true` permits a passport classified by
   Azure OCR but missing a reliable name to be retained as
   `extraction_status=pending`. The passport is explicitly **unverified**;
   Emirates ID must have a reliable extracted full name, used as the TEST
   invoice billing name. If a passport does yield a complete name, it must
   still match the Emirates ID. No non-passport document may use the exception.
   The flag defaults off and can never enable the exception in production.
4. Once both synthetic documents are accepted, Node automatically posts a
   **purchase-review prompt** to the same ticket, or asks for a synthetic
   `@example.invalid` billing email when missing. This notice is not order
   authorization. The quote-scoped notice is idempotent; for tickets whose
   documents were uploaded before this feature, the secure chat UI can recover
   the review through a customer-owned `POST /chat-journey/review` request
   without re-uploading documents.
5. Customer confirms the exact quote and the specific
   `PURCHASE_CONSENT` wording. Node creates a durable
   `ticket_purchase_confirmations` row; documents cannot be changed after
   confirmation. The model cannot grant or forge consent.
6. Node's payment OTP endpoints independently assert supported intent,
   verified quote, full configured document set and exact quote confirmation.
   Synthetic OTP is recorded only to the private n8n test Data Table with
   rate limiting, HMAC digest, expiration and max failures.
   If an earlier OTP dispatcher recorded a one-shot start marker but failed
   **before creating an OTP database row**, the worker may recover at most
   three times, at least 90 seconds between durable attempts, after rechecking
   the approved quotation and pre-validating synthetic billing input. The
   third recovery specifically accommodates tickets that exhausted the older
   retry budget against an erroneous quotation row lock. This is
   safe because the external n8n delivery call only occurs after the OTP row
   is committed. Existing OTP rows, even failed or expired, prohibit this
   automatic recovery; operators must use a separately authorized issuance
   process. The dispatcher logs finite error classifications rather than
   billing names, recipient addresses or OTP values.
7. Successful OTP authorizes exactly one durable sandbox order POST.
   The returned checkout URL is **not** evidence of payment.
8. After order creation, a bounded worker polls the private n8n authenticated
   GET endpoint (max 60 checks, minimum 30 seconds apart, one-day order window).
   Matching `COMPLETE` + amount + currency + reference + ticket + quotation
   grants `verified_test_payment`; `DECLINED` and `REFUNDED` never do.
9. Verified payment queues a Gotenberg PDF TEST invoice using the passport holder's
   **extracted full name**, corroborated against the Emirates ID. The quotation
   free-text customer name is never used as the invoice bill-to name. Before committing
   the result, the invoice worker rechecks that payment remains verified.
   A durable assistant ticket message then carries a same-origin,
   ticket-owner-authorized **Download your TEST invoice** attachment link.
10. For gateway decline/refund, the Node service adds an idempotent,
   persona-named/tone-adjusted assistant reply. Chat shows the current
   payment state; failed or uncertain payment never authorizes a PDF.

## Endpoints

- `GET /api/v1/tickets/:ticketId/purchase`: selected intent, checklist, consent
  status and OTP readiness; never returns document bytes
- `POST /api/v1/tickets/:ticketId/purchase/documents`: private base64 PDF/PNG/JPEG
  intake using `requirementKey, fileName, contentType, dataBase64`
- `POST /api/v1/tickets/:ticketId/chat-journey/review`: idempotently
  present the next Node purchase-review question after existing documents are
  accepted; never authorizes an order or payment
- `GET /api/v1/tickets/:ticketId/purchase/documents/:documentId`: owner-only file
- `POST /api/v1/tickets/:ticketId/purchase/confirm`: explicit confirmation for
  `requestId, quotationId, amount, currency, consent, consentText`
- Existing `/payments/otp`, `/payments/authorize`, `/payments/:id/verify`,
  `/invoices/:id/pdf` remain customer-owned; all operations are disabled
  unless existing development-only flags are enabled.

## Versioning and deployment

- Migrations `010`–`013` are forward-only. Database and workflows are
  never reset.
- `seed-sara-purchase.sql` is idempotent, clones the currently published
  4- or 21-intent catalog into a new revision when policy changes and retires
  the prior published revision. Existing tickets retain their pinned old
  catalog; open a **new ticket** to exercise the updated purchase journey.
- Existing offering revisions, knowledge and Foundry agent are untouched.
  The trusted turn context instructs Sara to retrieve the catalog's purchase
  requirements without asking for OTP, identity files or card details in chat.
- Required document rows are provisional. Do not enable real PII uploads over
  localhost HTTP. Production needs TLS, encryption at rest, retention policy,
  malware scan, document authenticity review and a legally approved matrix.
- Identity intake requires `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and
  `AZURE_DOCUMENT_INTELLIGENCE_KEY` on the Node API container. Without these,
  uploads fail closed. No other OCR provider/heuristic inference is used.
- The gateway docs have not established AED support, the accepted GET identifier
  or actual sandbox response behavior. Leave
  `ANCFZ_PAYMENT_DISPATCH_ENABLED=false` until manually confirmed. The
  automated GET worker and invoice worker are gated by that same flag.
- Payment failure replies are deterministic Node persona adaptations, not
  a new Foundry-generated inference. Republishing Sara's remote Foundry
  instructions can improve dialogue, but it does not authorize side effects.

## Validation

Run the static build/CI gates and a disposable database with a ticket pinned
to catalog revision 2. Verify missing documents and missing consent both block
OTP. Exercise duplicate uploads, cross-ticket document reads, incorrect OTP,
repeated order authorization, PENDING and DECLINED/REFUNDED, no invoice before
matching COMPLETE, and exactly one owner-only PDF attachment after completion.

The parser and mocked extractor are tested offline, but live Azure OCR for
actual Emirates ID format remains unverified and must be tested with approved
synthetic samples before enabling broader access.

The 2Checkout sandbox must be validated with synthetic data only. No
successful CI smoke is evidence of a live merchant transaction.


## Reopen existing hosted checkout from Sara (POC)

A customer with an already-reconciled, independently matched **PENDING**
MockGateway order can use **Regenerate / reopen existing payment link** in
Sara's in-chat secure transaction controls. This means **recovering the
same order's hosted URL**, not generating a new order or rerunning an OTP.

- `POST /api/v1/tickets/:ticketId/payments/:paymentId/checkout-link`
  accepts no identifiers or status from the browser. The ticket owner must
  already own the payment, which must have a durable RefNo and provider
  transaction ID and be in a checkout/pending state.
- Node invokes the private n8n payment-verification workflow, which issues
  an authenticated GET by RefNo and checks the exact ANCFZ external reference,
  original quotation/amount/currency and `PENDING` provider status.
  `COMPLETE`, mismatched, unknown and terminal payments cannot reopen.
- The HTTPS checkout URL is reconstructed only from the **stored** MockGateway
  transaction ID (or a previously stored exact matching URL), with an
  exact-host/path validator. No new provider POST is ever sent. A 10-second
  per-payment event cooldown prevents accidental reopening bursts.
- The browser opens a small, resizable `mockgateway.com` checkout window
  from the user's click. When it closes, it calls
  `POST /api/v1/tickets/:ticketId/payments/:paymentId/checkout-closed`.
  Popup blockers receive a safe same-order link and can manually verify.
- Window closure, browser redirects and gateway notifications **are not**
  payment evidence. The close endpoint calls the existing authenticated
  `PaymentOperations.verify`, and writes `payment.checkout_closed_checked`
  to ticket SSE, plus a deduplicated assistant notice when the order is
  still `PENDING`. A separate authenticated `COMPLETE` is the **only** path
  to an idempotent TEST invoice; subsequent invoice rendering emits the
  usual chat/SSE milestones.
- If payment is `unknown_outcome` with no stored order references, the
  customer must first complete the existing guarded reconciliation. This
  link-recovery feature intentionally does not bypass the five-attempt
  lookup limit or reactivate the original dead order-creation outbox.

Test with a synthetic matched order before enabling the UI. No production
card data, original OTP values or merchant secrets should be entered in chat.

## Verified quotation → quote OTP → private documents (2026-11-18)

A verified quotation PDF is **not** permission to upload identity files. Sara's
Secure transaction modal now presents the contact email already captured in
the conversation and requests an explicit confirmation of that address before
creating a **separate quotation confirmation OTP**. The sandbox code is
recorded privately in the existing n8n mock OTP test table, never delivered
to an actual recipient, placed in the normal message queue, or submitted to
Foundry. The quote OTP has a five-minute lifetime, bounded retries and
ticket/agent-scoped PostgreSQL row-level security.

**Mock Data Table recipient:** The user's confirmed real contact email stays
in the agent/ticket-scoped quotation OTP row for contact verification; it is
**not forwarded to n8n**. For the test-only `ancfz/otp-email` webhook, Node
creates a unique `quote-<challenge-uuid>@example.invalid` address, just as
the separate sandbox payment OTP uses an `@example.invalid` alias. The
`ANCFZ_POC_OTPS` table receives the synthetic address, ticket ID and test
code only. The customer retrieves the latest code from the private n8n Data
Table. The existing local-only mock workflow must be active (and the original
SMTP workflow inactive) or Node fails the challenge without unlocking any
document intake. Quote issuance limits remain five per rolling hour and 60
seconds between requests, even when a dispatch fails. No migration or
recreation of the existing quote is required for this correction.

Only a confirmed quotation OTP unlocks document/OCR intake, including
backend POST routes. The quote OTP does not approve a purchase or charge a
card. After both synthetic documents have been accepted, the existing exact
purchase proposal and **distinct payment OTP** remain mandatory.

Billing email is not collected a second time: the original contact's
local part becomes a disposable `@example.invalid` alias when an explicitly
supplied `customer_test_email` is absent. The derived alias is shown in the
exact-amount purchase proposal and the customer authorizes that specific
snapshot. This is only a **synthetic test identity**; no real email delivery
occurs.

The transaction UI is a modal with a clear OCR upload-progress indicator.
SSE transaction state appears in the conversation timeline; the ordinary
composer pauses while a known provider operation is actively running, but
private modal inputs remain available. In-progress or unknown external
provider outcomes are never treated as completed payments.

**Migration:** `016_quotation_confirmation_otp.sql` creates the isolated
quotation challenge state. Apply migrations through the existing `migrate`
service before deploying the updated API. Preserve PostgreSQL volumes and
the previously captured `prime` rollback images.

## Stable TEST agreements and renewals (November 2026)

This is a **local nonbinding POC**. Real ANCFZ contracts, invoicing, identity
validation and legal execution require separate production approval.

A verified sandbox payment produces a NEW invoice; once its PDF is verified,
the contract worker prepares the private TEST service agreement. It includes
the exact **quotation number**, **invoice number**, stable **agreement number**
`ANCFZ-AGR-YYYY-######`, and revision. The agreement number is allocated
atomically in PostgreSQL and cannot be generated by n8n or a model.

The private n8n Data Table `ANCFZ_POC_AGREEMENTS` mirrors only the current
agreement number, revision, ticket ID, quotation number, invoice number, and
state; it does not receive passport/Emirates ID images, name, or identity number.
The register is an **upsert by stable agreement number**: renewal updates the
existing row; PostgreSQL retains every immutable agreement revision and PDF.
n8n sync failures retry with bounded backoff and cannot roll back a verified
PDF or create any payment. Never use the n8n row alone as payment proof.

### Existing n8n installation

Do not reset n8n volumes, owner or credentials. The new workflow is
`infra/n8n/ancfz/07-agreement-register.json` and shares the existing private
`ANCFZ - Node to n8n Webhook Header` credential. With `APP_ENV=development`
and the existing n8n owner API key supplied privately to `N8N_API_KEY`:

```powershell
node scripts/setup-n8n-agreements.mjs --dry-run
node scripts/setup-n8n-agreements.mjs --inspect
node scripts/setup-n8n-agreements.mjs --setup
node scripts/setup-n8n-agreements.mjs --inspect
```

Then open the local n8n editor and activate **ANCFZ | Agreement Register Data
Table (LOCAL ONLY)**. Never activate its endpoint publicly. The installer
does not activate workflows, overwrite existing tables, or import credentials.
An existing table schema mismatch fails closed. Every successful agreement
has a queued, idempotent synchronization attempt. Workflow activation is
required before claiming live Data Table sync is complete.

### Renewal lifecycle

On an existing **completed** agreement, the authenticated ticket owner
explicitly consents to renewal in Secure transaction. Node creates a
**separate renewal ticket**, linked to the same agreement master. This preserves
the original quote, invoice, agreement PDF and payment evidence. A new ticket
inherits only owner-authorized, non-disputed company facts and the previously
verified Salesforce enquiry reference. It reuses privately stored validated
synthetic identity evidence with separate renewal annexure consent; document
images never enter chat or the n8n register.

Sara prepares a NEW quote against the current published catalog and price.
The customer separately approves the new quote and purchase; a fresh sandbox
payment OTP and independently verified gateway payment are mandatory.
Only a completed renewal invoice permits the updated agreement PDF. The
base agreement number is unchanged; the revision increments and its PDF
filename uses a suffix such as `-R02`. On successful finalization, Node
updates the current revision and the same n8n Data Table row. Historical
agreements remain available under their own owner-authorized ticket.
A declined/unknown/refunded payment never updates the agreement.

Guests must retain the same authorized session. An agreement number alone
does not authenticate a renewal after the cookie expires; authenticated
cross-session account recovery requires the existing verified-account path.

### Recovery for earlier missing TEST contracts

Migration `019_service_agreements.sql` backfills contract numbers and links
to original invoices. It performs a **one-time** requeue of previously
`needs_review` contracts only if payment is still independently verified,
the invoice PDF exists, and the exact private document-annexure consent was
recorded. On an invoice with no contract row, the contract worker can recover
the missing row using the same consent and payment evidence. The renderer
uses previously OCR-validated Emirates ID last-four when a second OCR check
is transiently unavailable; it does not fabricate a full number. An unresolved
identity mismatch remains `needs_review`.

### Acceptance criteria

- Missing or stale consent never generates a service agreement.
- Duplicate payment/renewal requests cannot generate a second agreement number.
- Renewal quote and invoice numbers differ from the original; agreement number
  is identical and revision strictly increases after successful payment.
- An authorized guest can renew only the most recently verified revision.
- No invoice, provider-verified payment or matching original documents:
  no agreement PDF or n8n state advancement.
- Stale n8n webhook responses cannot advance PostgreSQL revision or payment.
- Local end-to-end testing must verify PDF bytes, register upsert, and full
  renewal flow; CI static/integration checks do not prove n8n activation.
