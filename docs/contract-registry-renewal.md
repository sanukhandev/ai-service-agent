# ANCFZ contract register and renewal design (sandbox)

## Current contract creation

- The verified quotation and a separately authorized sandbox payment remain mandatory.
- The TEST invoice and contract are different outputs of the same payment.
- The contract renderer now waits for a verified, persisted invoice before rendering.
- The agreement displays its **stable contract number**, **agreement revision**, **quotation number** and **matching invoice number**. The first revision is 1.
- Contract numbers are allocated by PostgreSQL, for example `ANCFZ-SC-2026-000001`. Do not allocate identities from n8n or LLM-generated text.
- The contract PDF contains the source-approved package, terms, known requirements and private passport/Emirates ID annexures. A second OCR outage can only produce a **masked last-four** identity number from previously accepted evidence; it never fabricates a full ID number or accepts contradictory OCR.
- The contract is a nonbinding, unsigned TEST agreement. A successful provider status alone is not a legally executed contract.
- A one-time migration retries previously exhausted agreements whose verified invoice exists, without redoing payment or recreating the quotation.

## n8n contract registry

The `ANCFZ_POC_CONTRACTS` Data Table is a **non-authoritative projection** of PostgreSQL contract records. It stores **contractId**, **contractNumber**, **revision**, **ticketId**, **quoteNumber**, **invoiceNumber**, and **status** only. It holds no passports, Emirates ID number, DOB, billing email, OTP or PDF bytes.

The private authenticated webhook `POST /webhook/ancfz/contract-registry` uses `ANCFZ | MOCK Contract Registry (LOCAL ONLY)` and performs an idempotent upsert by immutable contractId. The Node worker resends pending records until the expected acknowledgement is returned and then marks the row `synced`. An uncertain POST is safe to retry **only because the upsert is keyed to contractId**; it never authorizes another payment or contract.

### Local setup (existing n8n instance)

1. Ensure the existing n8n owner, volume, `N8N_ENCRYPTION_KEY` and `ANCFZ - Node to n8n Webhook Header` credential are preserved.
2. Pull the code, build/recreate **api** and **n8n** as necessary, and apply migration `019_contract_registry.sql` through the existing migrate service.
3. Provide the existing n8n owner key **privately** as `N8N_API_KEY`, then run:

   ```powershell
   node scripts/setup-n8n-contract-registry.mjs --dry-run
   node scripts/setup-n8n-contract-registry.mjs --inspect
   node scripts/setup-n8n-contract-registry.mjs --setup
   ```

4. Open `http://localhost/n8n/`, review **ANCFZ | MOCK Contract Registry (LOCAL ONLY)**, confirm the existing private Header Auth credential, and **activate** the workflow. Do not activate an externally accessible webhook or store the real ID number in the table.
5. Read-only inspect: `node scripts/setup-n8n-contract-registry.mjs --inspect`; confirm the Data Table is populated with the same contract number and quote/invoice references shown in the TEST PDF.

**Important:** A repository pull does not install/activate a workflow in the existing n8n database, and a successful compile does not certify the live workflow. If the n8n service is unavailable the PDF can still complete; `registry_sync_state=pending` is recoverable without reissuing an invoice.

## Renewal workflow architecture

Renewal **must be a new commercial transaction linked to the original contract**, not an edit to an already-issued PDF/invoice:

1. Authenticated customer explicitly selects an existing contract and requests renewal, then reviews the renewal period, current package, and price.
2. The service checks the original contract and authorization; it creates a **new renewal ticket / quote cycle**, not a new customer/company identity. The existing contract number remains unchanged.
3. A **new quotation**, with its own quote number and new price snapshot, is approved; a **new payment OTP** and independently verified payment are required.
4. The new paid invoice gets its own invoice number.
5. The agreement is issued as revision `N+1` under the **same contract number**, with its own document ID/PDF and links to the new quote and invoice.
6. n8n upserts the new agreement revision row by immutable contract ID. Renewal must not overwrite or delete the earlier PDF, quote, or invoice.

The linked workflow is implemented on feature branch `feat/ancfz-contract-renewal-completion` with migration `020_contract_renewals.sql` and `ticket_contract_renewals`. It uses **existing private verified ANCFZ-SC agreements**, not arbitrary licence numbers. The earlier licence lookup PR #37 was closed unmerged; a source-of-truth mapping from issued licence number to contract is a separate integration and must not be fabricated.

### Renewal operation contract

- Enable `ANCFZ_RENEWAL_ENABLED=true` only in `APP_ENV=development`. Apply migration 020. Keep quotation dispatch, secure OTP, sandbox payment and invoice workers independently configured. There is no real licence issuance.
- Publish an actual owner-approved, positive AED offering with key beginning `renewal_` **under the same intent as the previously purchased package**, in the current published offerings catalog. Without this configured price, preview returns unavailable and **no quote or payment is created**. New company setup prices are not renewal rates.
- In Sara's secure chat, view the original verified service contract, select **Renew this agreement**, review the exact renewal-specific amount, and explicitly accept the disclosed scope. The browser calls `GET /api/v1/tickets/:ticketId/contracts/:contractId/renewal/preview` followed by `POST /api/v1/tickets/:ticketId/contracts/:contractId/renewal/start` with an idempotent `requestId`, exact key/price revision/amount/currency, and exact server-issued `consentText`.
- Node verifies current contract ownership against the guest session, original verified TEST payment and invoice, stored PDF checksum, original verified Salesforce lead, and matched private passport/Emirates ID evidence. A second renewal cannot be pending for the same contract number; stale revisions fail closed.
- Node creates a **new ticket** in the same owner session, records a new customer authorization, copies sourced business facts and private synthetic evidence into this new ticket, and records a completed *reuse* of the earlier independently verified Salesforce lead. It does **not POST a new lead**. The original bytes and PDF remain unchanged. The source ticket's pinned intent must still be published with quotation and purchase actions.
- The new quotation uses the published `renewal_` offering and effective price snapshot, with exact amount/revision check. The browser transitions to the linked renewal ticket. From there the existing quotation OTP, purchase consent, synthetic payment OTP, independent payment GET and TEST invoice are reused. Payment-verification code creates an agreement with the **same** `contract_number`, incremented `agreement_revision` and `renewal_of_contract_id`.
- The service-contract worker remains active for already-paid invoices even if new payment dispatch is disabled. It renders the next-version PDF after invoice verification, updates the renewal state to `completed` in the same transaction, and synchronizes non-PII references through the existing contract registry workflow.

**Validation boundaries:** The offline code safety test is `node scripts/check-contract-renewal.mjs`; the isolated P3 Docker CI covers compilation, migration and RLS. Neither proves real n8n registration, live Foundry behavior, OCR acceptance, MockGateway payment or a complete end-to-end renewal. A live synthetic trial is required before enabling customer use. No renewal price or official renewal fulfilment is seeded automatically.

## Read-only diagnostics for a missing contract

```sql
SELECT c.contract_number,c.agreement_revision,c.state,c.render_attempts,
       c.failure_code,c.registry_sync_state,
       q.document_number AS quotation_number,
       i.document_number AS invoice_number,i.state AS invoice_state,
       p.state AS payment_state
FROM ticket_service_contracts c
JOIN ticket_quotations q ON (q.agent_id,q.ticket_id,q.id) =
  (c.agent_id,c.ticket_id,c.quotation_id)
JOIN ticket_payment_attempts p ON (p.agent_id,p.ticket_id,p.id) =
  (c.agent_id,c.ticket_id,c.payment_id)
LEFT JOIN ticket_payment_invoices i ON (i.agent_id,i.ticket_id,i.payment_id) =
  (c.agent_id,c.ticket_id,c.payment_id)
WHERE c.ticket_id = '588dd13c-5420-41c1-9210-82f7bd53ed1b';
```

An empty result means **no contract was queued** (check the exact purchase consent). A state of `queued` may indicate invoice has not completed. `needs_review` and `failure_code` identify why the renderer exhausted its retries.
