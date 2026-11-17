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
   twice, at least 90 seconds between durable attempts, after rechecking the
   approved quotation and pre-validating synthetic billing input. This is
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
