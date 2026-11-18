# ANCFZ declined payment recovery and private TEST service contracts

## Customer flow

1. A verified quotation, quotation OTP, uploaded passport/Emirates ID, and explicit purchase/payment authorization remain the prerequisites.
2. After a provider-confirmed `DECLINED` status, the original payment attempt and gateway references remain permanently recorded. The chat offers **Retry declined payment — request new OTP**. The customer explicitly selects it; Node never automatically retries a POST.
3. Node creates a new six-digit **synthetic** OTP challenge with a fresh request UUID. The existing five-attempt/hour and one-minute cooldown protections still apply. The old OTP is expired; its value is never reused. Failed, expired, consumed, or delivery-failed challenges can also be retried by the customer subject to the same rate limits.
4. After the new OTP is verified, Node creates **one new** payment attempt with a new provider reference, payment ID, outbox row and idempotency key. The new sandbox checkout link is sent to chat by the existing payment worker.
5. Quotation approval, price revision, private document uploads, consent snapshot, and ticket remain intact. Only OTP, payment attempt, and checkout steps restart. No invoice/contract is issued from a redirect or a successful order POST.
6. `PENDING`, `UNKNOWN`, `REFUNDED`, and successfully paid attempts do **not** authorize creating another order. Resolve the existing gateway reference instead; uncertain side effects are never replayed.

## Service contract after verified sandbox payment

- A distinct record in `ticket_service_contracts` is queued in the **same database transaction** as independently verified payment, provided that the exact new purchase consent explicitly authorizes including passport and Emirates ID copies in the contract. Old purchase consent cannot be silently expanded.
- A private Node worker rechecks payment state and the frozen quotation, retrieves only ticket-scoped matching passport and Emirates ID documents, checks SHA-256, OCR holder name and Emirates ID number/last four, and builds a detailed **nonbinding** ANCFZ demonstration contract.
- Service inclusions and price conditions come from the immutable **paid quotation**. Requested customer preferences are separated from purchased inclusions. No unsupported benefits, visa approvals, or service commitments are invented.
- The first-party signature block is **/s/ ANCFZ Authorized Representative — DEMO**, expressly marked **not cryptographically signed and not legally executed**. This is not an actual e-signature, certificate, customer consent to legal terms, or substitute for a real approved contract.
- Annex A is a full copy of the submitted passport. Annex B is a full copy of the submitted Emirates ID. Image uploads are privately converted to PDF; PDF uploads are privately appended. Gotenberg merges these with the contract without public web access.
- Customer's full name and Emirates ID number are re-extracted from the authenticated, privately stored ID. If OCR evidence conflicts or cannot recover the full number, the contract pauses in `needs_review`; it must not invent or synthesize identity details.
- Both the document and SHA-256 remain in the agent-scoped RLS PostgreSQL record. GET `/api/v1/tickets/:ticketId/contracts/:contractId/pdf` checks ticket ownership, completed verified payment, completed contract state, and PDF integrity. Download uses `private, no-store`. The contract notice and customer link are shown only on the authorized ticket.
- Refund or loss of verified payment status makes the contract inaccessible even if a prior PDF was generated.

## Database changes

The ordered additive migrations are `017_declined_payment_retry.sql` and `018_test_service_contracts.sql`, following the pre-existing `016_quotation_confirmation_otp.sql`. They retain prior payment records and introduce an indexed replacement-attempt chain with at most one non-declined attempt for each quotation. They also introduce a separate RLS-protected contract ledger.

## Acceptance checks (must be executed before merge)

- Declined -> request new OTP -> OTP verification -> new authorized order -> new hosted link -> verified paid -> exactly one paid invoice and one private service contract.
- Retry via duplicate request UUID cannot create a second order; multiple simultaneous requests are serialized by ticket locks and constrained by the partial unique index.
- Requests to retry PENDING/UNKNOWN/REFUNDED/COMPLETE are denied. Old declined attempts cannot reactivate once superseded.
- Wrong/expired/consumed OTP, mock delivery failure, cooldown and rate-limit boundaries.
- No CRM lead, quotation, document or original payment history is erased during retry.
- Quotation service descriptions, pricing and identity documents must come from the correct ticket/quote; cross-agent/cross-ticket access is denied.
- No full Emirates ID, OCR document bytes, OTPs, or personal data in Foundry prompts, events, chat transcript or application logs.
- TEST PDF pages include the contract plus readable passport and Emirates ID annexures. Both PDF and image source files must be validated.
- Refund after contract generation revokes download. Worker restart/failed renderer must not publish a partial contract.
- Run API/web TypeScript builds, migrations against a disposable PostgreSQL database, local Gotenberg PDF rendering and real sandbox end-to-end flows. **These have not been performed in this change set's connector-only authoring environment.**
