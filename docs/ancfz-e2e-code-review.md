# ANCFZ POC conversation-to-invoice code review

## Scope

Code-path review of `feat/ancfz-intent-purchase-documents` against
`AGENTS.md`, the ANCFZ 4-intent bootstrap catalog, the optional 21-intent
test catalog, and the existing PostgreSQL/Foundry/n8n integration.

This is not a claim of flawless live merchant or OCR behavior. All local CI
provider tests use disposable databases or synthetic responses. PR remains
unmerged until review.

## Implemented customer journey and authoritative owners

| Stage | Authority | Execution or evidence |
|---|---|---|
| Intent discovery | Sara/Foundry, via Node allowlisted tools | `find_intents`; selected catalog is pinned to ticket |
| Intent selection | Node | `select_ticket_intent`, one active goal; cannot switch after documents or authorized business actions |
| Facts and prerequisites | PostgreSQL | Customer-message provenance; `get_intent_requirements`; same catalog checks enforced on direct Lead and quotation APIs |
| Available action | Node | `GET /intent-actions` returns allowed actions and their missing facts; unsupported actions are never silently run |
| Service request | Node | Customer-approved, idempotent, RLS-scoped `awaiting_staff_review` ticket record. No bank/government integration implied |
| Salesforce Lead | Node/n8n | Explicit contact-sharing consent, validated fields and catalog prerequisite gate, independently verified Salesforce Lead ID |
| Quotation | Node/n8n/Gotenberg | Verified Lead, required catalog facts, effective published price, customer acknowledgment and verified PDF |
| Identity upload | Node/Azure Document Intelligence | Passport + Emirates ID only, private ticket bytes, normalized OCR names must match; not authenticity/KYC |
| Purchase | Node | Same quoted amount/currency, document completion and explicit purchase consent |
| OTP/order | Node/n8n | Synthetic 6-digit OTP, HMAC/expiry/rate limit, single durable 2Checkout order POST; no retry on ambiguous POST |
| Payment verification | Node/n8n read-only GET | Correlated provider reference, amount, currency and status; no redirect/HTTP 200 can attest paid |
| Invoice | Node/n8n/Gotenberg | Verified COMPLETE plus document-derived billing name; private PDF and ticket chat download link |
| Failure/refund | Node | Persona-name/tone ticket notices; no paid PDF without currently verified payment |

## Specific failures found and corrected during the review

1. **Transient gateway GET after COMPLETE**: state was overwritten as
   `unknown_outcome` despite no legitimate reversal evidence. Added
   `reconcileGatewayCheck`: preserve COMPLETE through failed/PENDING/DECLINED
   lookups and recovered verification leases, allow independently corroborated
   REFUNDED to revoke invoice access, and never resurrect REFUNDED from stale
   COMPLETE evidence. Offline regression cases added to
   `scripts/check-p5-2checkout.mjs`.
2. **Lost invoice chat link**: previously a worker interruption between
   committing the PDF and appending the assistant message left no automatic
   delivery path. Added idempotent recovery based on the invoice ID and a
   missing assistant-message lookup; chat-notification failure is isolated
   from unrelated invoice rendering.
3. **Direct Lead/quotation catalog bypass**: previously the action panel
   showed catalog-required facts but direct API submit paths checked only
   their local form/Lead/price gates. Both now invoke the same
   `assertCatalogActionRequirementsTx` before creating an operation, and the
   UI prompts for the missing information instead of allowing premature
   submission. Disposable P3 fixture messages were updated to actually
   provide and retain the required fact provenance.
4. **Refund changes after successful payment**: the bounded read-only status
   worker now checks verified sandbox orders every 10 minutes (maximum
   60 total checks, within the existing 24-hour window) to detect
   provider-confirmed refunds and retract paid invoice access.

## Explicit limitations and follow-up acceptance

- Intent recognition and follow-up language are model-driven, but **full
  declarative catalog-driven stage advancement is not implemented**.
  Customer-visible action controls currently connect the stages. Node
  orchestrates authorized side effects after the user consents; intent
  selection alone never creates an external Lead, invoice, referral or order.
- No exhaustive live Foundry replay of 21 example intents; CI verifies
  the action mapping and representative Node operations only.
- No successful live Azure Document Intelligence passport/Emirates ID
  extraction or document authenticity proof. Strict name matching can
  reject legitimate transliteration variants. A user cannot replace an
  already uploaded different file through the self-service interface;
  use a new test ticket when sample documents are wrong.
- No live Salesforce/2Checkout AED payment/REFUNDED/E2E invocation in CI.
  Payment dispatch must remain disabled until the merchant credential,
  supported currency and GET order reference are verified manually.
- Non-provider actions only record service requests for staff review;
  they do **not** call immigration, bank, legal partner or other third-party
  APIs.
- The local development service uses localhost HTTP. Upload synthetic
  identity samples only; this is not an approved production PII storage path.
- PDF chat messages contain same-origin owner-authorized download links,
  not inline PDF bytes. The invoice download API rechecks current verified
  payment state and refuses access after refund.

## Validation

The GitHub CI checks cover API/Next build, migration ownership,
catalog publication, disposable PostgreSQL intent/document/consent actions,
n8n workflow structure and local proxy smoke. See the exact PR-head checks
rather than borrowing a past green commit. Full Foundry/merchant/real-document
E2E acceptance is still required before calling the POC demonstrated.
