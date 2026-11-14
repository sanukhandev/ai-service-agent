# ANCFZ intent execution matrix — POC review

## Key decision: intent recognition is not consent

The existing Sara Foundry functions **find**, **select**, **read requirements**,
**record customer-provided facts** and **read priced offerings**. They never
create leads, orders, documents, referrals or invoices on their own. After
an intent is selected, the Node-owned **intent action panel** reads the
ticket-pinned catalog and presents **only actions allowed by that intent**.

For the POC, all seven ticket-request actions also require the customer's
passport and Emirates ID to have been uploaded, OCR-extracted and cross-matched.
The secure document checklist is visible for all selected intents, including
those without a priced quotation. No invoice is generated solely from document
uploads.

Each action requires the appropriate customer-controlled authorization.
Unknown/unimplemented future catalog actions are explicitly shown as
unavailable, not silently attempted.

## Supported Node action handlers

| Catalog action | Node execution kind | Actual side effect |
|---|---|---|
| `create_lead` | `salesforce_lead` | Customer authorizes contact sharing; Node queues a single Salesforce lead via existing private n8n workflow, independently verifies Lead ID |
| `generate_quote` | `quotation` | Only after separately verified lead and effective, published price; customer acknowledges non-binding quote; Node queues Gotenberg PDF |
| `purchase_quotation` | `purchase` | Only when that intent allows `generate_quote`; upload passport + Emirates ID; OCR names agree; exact quote consent, synthetic OTP, one-shot 2Checkout order and independent GET status; verified COMPLETE queues invoice |
| `create_enquiry` | `ticket_request` | After required facts and explicit consent, record a ticket-scoped service request for staff review |
| `create_renewal_request` | `ticket_request` | Same, with licence renewal facts |
| `create_amendment_request` | `ticket_request` | Same, with amendment facts |
| `create_visa_enquiry` | `ticket_request` | Same, with visa-specific facts |
| `create_referral` | `ticket_request` | Same, with relevant referral facts |
| `request_specialist_review` | `ticket_request` | Same, with specialist-review facts |
| `create_support_request` | `ticket_request` | Same, with customer support facts |

**Ticket requests do not send data to a bank, immigration authority, third
party or partner.** Those integrations do not exist in the repository. They
are marked `awaiting_staff_review` and appear in a durable customer chat
message. Do not describe them as completed external operations.

## Catalog sizes and prerequisites

The bootstrap catalog has **4 intents**. The independently published ANCFZ
test catalog has **21 intents, 97 offerings and 55 source-derived test
price variants**. The test price variants belong to `company_formation`.
The quote-request and package-comparison intents can access the same
published, pinned-price company-formation offers after an authorized lead.

The remaining intents have informational or unpriced offerings. Their
service-request actions are executable in the ticket, but there is **no
grounded monetary quote** to charge. Node must refuse payment/invoice rather
than invent a price. Adding an approved offering revision and an authorized
`generate_quote` action is a separate, deliberate catalog publication.

Every intent accepts the same two POC documents after selection:
`passport` and `emirates_id`. A strict private Azure Document Intelligence
OCR check extracts full names and the ID last four characters.
Uploaded bytes remain ticket-scoped in PostgreSQL. Customer data is never
copied into Foundry tool output or n8n. A matching OCR name is not
authenticity, KYC or legal identity verification.

## Publication and backward compatibility

`seed-sara-purchase.sql` clones the **currently published** catalog into
a new immutable revision if its universal-document/quote action policy
needs changes. Reruns are no-ops. Existing tickets remain pinned to
their original catalog. The 21-intent operator publication preserves Sara's
allowlisted `toolNames` in the agent version and adds the two ID
requirements to all new test intents. Publishing source records from a
new seed version is still an explicit owner action, not a conversation action.

## Validation

- Static 21-intent matrix asserts every published source action maps to a
  defined Node executor; unknown actions fail the contract test.
- P3 disposable DB executes `create_enquiry`,
  `create_renewal_request` and `create_referral` through the common
  service-request handler, including required passport/Emirates ID upload
  before any price exists, OCR name matching, missing-fact rejection,
  consent refusal, replay/idempotency, cross-ticket ownership and a
  stable staff-review chat notice.
- Lead, quotation, passport/Emirates ID readiness, OTP gating, order
  correlations, invoice and payment safety retain separate offline tests.
- CI does not prove live Foundry tool selection for each of 21 example
  phrases, live Salesforce, n8n merchant payments, or real Azure OCR.
  Those are explicit POC integration acceptance gates.

**Safety note:** Only upload **synthetic** passport and Emirates ID data to
the local HTTP POC. Never process real customer identity documents without
TLS and a deliberate privacy/security review.
