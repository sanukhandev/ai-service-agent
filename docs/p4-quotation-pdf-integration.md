# P4 quotation PDF — customer-authorized, server-priced and ticket-private

Status: **implemented in Node, behind an opt-in flag; live Gotenberg/n8n certification pending**.

This slice is the next stage after the ANCFZ Salesforce Lead integration.
It adds no model function for external operations and does not change the
conversation engine or the existing Foundry IQ knowledge binding.

## Execution

1. A customer starts a ticket and Sara selects a published intent allowing
   `generate_quote`.
2. Customer explicitly authorizes ANCFZ Salesforce lead submission through the
   separate chat form. The lead worker returns `verified_completed` only when
   n8n's Apex REST response contains a matching `00Q...` Lead ID.
3. The customer requests a quotation with a separate, explicit acknowledgment,
   selecting an **effective published offering** shown from their ticket's
   **pinned offering catalog version**. Neither a customer parameter nor a
   Foundry model response supplies the amount.
4. Node requires the verified Lead, active eligible intent, ownership and
   exact acknowledgment text. A quote cannot exist for the ticket before the
   verified Lead. One quote per ticket is supported in this POC.
5. Node snapshots the offering ID, immutable price revision, price, currency,
   label, conditions, Salesforce Lead ID, customer name and generated
   `ANCFZ-TEST-Q-<uuid>` document number. It atomically creates a scoped
   `ticket_operations` row and `event_outbox` record. Concurrent duplicate
   requests are serialized on the ticket; identical requests return the
   existing quote and conflicting details receive HTTP 409.
6. An opt-in Node worker dispatches only to the private fixed
   `http://n8n:5678/webhook/ancfz/render-pdf`, using the configured
   `X-ANCFZ-Workflow-Key` Header Auth credential.
7. The n8n workflow renders **quotation only** through Gotenberg.
   The existing workflow supports invoices, but this integration does not.
   The Node worker verifies a matching ticket and document number, exact
   document type, JSON status, PDF MIME, base64 encoding, size under 5 MiB,
   PDF signature and EOF marker. It computes SHA-256.
8. Node stores the PDF bytes in the RLS-scoped PostgreSQL
   `ticket_quotation_pdfs` table, then marks the operation
   `verified_completed` and emits an SSE event atomically.
   A bad/absent/uncertain response becomes `unknown_outcome`, without
   blind retries. PDF validity checks are a bounded structural check, not
   independent legal approval of generated content.
9. The PDF is only downloadable using a valid guest/customer ticket session
   through `GET /api/v1/tickets/:ticketId/quotations/:quotationId/pdf`.
   Response uses `application/pdf`, `no-store`, attachment disposition and
   `nosniff`. Raw bytes and private n8n URLs are never included in the chat
   transcript, SSE events or customer-facing JSON.

## Operator setup — local Docker

- Pull the merged PR and run migration 008 through the existing
  `migrate` service. **Never reset the existing PGDATA volume.**
- Ensure Sara's published Foundry version 6 and the active PostgreSQL agent
  binding match. Existing tickets remain pinned to their creation version.
- Follow `docs/p4-node-n8n-lead-integration.md` to configure the private
  n8n instance and *real* Salesforce sandbox OAuth credential. Test one
  disposable Lead and verify its exact ID and response shape first.
- In n8n, configure a real Header Auth credential on
  **ANCFZ | PDF Quotation or Invoice** and activate only the template after
  verifying a genuine Gotenberg render. It shares the same private header
  credential as the Salesforce Lead worker.
- Add to private local `.env`:

  ```dotenv
  ANCFZ_QUOTE_DISPATCH_ENABLED=true
  ANCFZ_N8N_WEBHOOK_SECRET=<shared-private-header-auth-secret>
  ```

- Run `docker compose --profile workflows up -d n8n gotenberg`
  and rebuild/recreate `api` and `web` after checkout.
- With a new ticket, select the intent and submit the Lead through the
  explicit follow-up form. After the Lead is verified, use the
  **Request a non-binding test quotation** form. Select the appropriate
  visa count/term price, confirm and download the PDF.

**Source price caveat:** ANCFZ's 2026 matrix is marked
`TEST PUBLISHED` and pending formal source review. The generated PDF is
explicitly a non-binding test quotation, not an invoice. Unverified taxes,
health insurance and office upgrades are not silently added. Before any
external/production quotation, obtain ANCFZ business sign-off on prices,
taxes, exclusions, template legal terms and authority to quote.

## Diagnostics

Owner-only PostgreSQL query:

```sql
SELECT t.ticket_number,q.document_number,
  q.offering_key,q.price_revision,q.amount,q.currency,
  op.state,op.provider_status,op.provider_reference,
  d.sha256,octet_length(d.bytes) AS pdf_bytes
FROM ticket_quotations q
JOIN tickets t ON t.agent_id=q.agent_id AND t.id=q.ticket_id
JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.id=q.operation_id
LEFT JOIN ticket_quotation_pdfs d
  ON d.agent_id=q.agent_id AND d.ticket_id=q.ticket_id
  AND d.quotation_id=q.id
ORDER BY q.created_at DESC LIMIT 20;
```

API:
- `GET /api/v1/tickets/:id/quotation-options` → capability, Lead check, current prices
- `POST /api/v1/tickets/:id/quotations` → customer-authenticated acknowledgment
- `GET /api/v1/tickets/:id/quotations` → scoped status and document metadata
- `GET /api/v1/tickets/:id/quotations/:quotationId/pdf` → owner-only PDF bytes

Offline gate: `node scripts/check-p4-quotation.mjs` after API compile,
and disposable PostgreSQL smoke in `scripts/p3-integration-smoke.sh`.
These do not call Salesforce, n8n or Gotenberg.

## Out of scope / follow-up

- Live n8n and Gotenberg end-to-end proof requires the operator's
  configured private instance and credentials.
- Payment OTP, hosted checkout, independent status verification, invoice
  issuance and document-upload OCR are later milestones.
- Production deployment needs TLS, proper form CSRF protection,
  retention controls and external document/object storage for scale;
  Postgres bytea is an intentionally small, private POC storage approach.
