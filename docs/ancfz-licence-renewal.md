# ANCFZ synthetic licence renewal — n8n Data Table, quote and checkout

## Scope and safety

This is a **local development POC**, not a real regulatory renewal service.
Only synthetic licence references matching `ANCFZ-TEST-...` are accepted.
Lookup alone does not prove ownership and must never authorize an order,
claim an official renewal, or expose real customer/identity records.
No production customer can use this endpoint:
`APP_ENV=development` **and** `ANCFZ_RENEWAL_LOOKUP_ENABLED=true`
are both required. n8n is the read-only licence record source; Node is the
authoritative ticket, consent, quotation, order and invoice controller.

## Complete flow

1. The model selects the **Renew a licence** (`license_renewal`) intent.
2. The customer enters a synthetic licence number in Sara's secure in-chat
   renewal form. The Node API validates ticket ownership, the input format,
   and a per-ticket limit of five lookups per hour.
3. Node calls the private, Header Auth-protected n8n
   `POST /webhook/ancfz/renewal-lookup`. n8n's Data Table **Get row**
   uses an exact licence-number match with a maximum of two rows. The workflow
   returns either a sanitized unique result, `not_found` or `review`.
   Suspended/cancelled/duplicate records fail closed. No table update runs.
4. Node stores the matched synthetic company name, licence number/status,
   expiry, renewal term, published renewal offering **key** and SHA-256
   fingerprint in `ticket_licence_renewals` with agent/ticket RLS.
   The browser displays the matched details for **explicit customer
   acknowledgement**. The acknowledgment is not ownership proof.
5. On acknowledgement, the record becomes immutable for the ticket and Sara
   asks for the contact name, phone and email for the renewal enquiry.
6. Node **only** prepares a non-binding quotation when a **published,
   positive-priced renewal offering** matching the confirmed n8n offering
   key exists in the ticket's pinned offering catalog. Do not invent,
   infer, substitute a new-company formation price, or accept amounts
   supplied in chat or from the n8n lookup response. Quote includes licence
   number, company, expiry, renewal term, exact published rate and conditions.
7. Customer reviews and explicitly authorizes the scoped CRM lead and
   quotation. Existing Node outbox/n8n/Gotenberg creates and independently
   verifies the detailed quotation PDF.
8. The existing purchase path requires both configured synthetic identity
   documents and exact quotation-specific purchase consent. Node then issues
   a separate synthetic OTP. Only a verified OTP can initiate the sandbox
   order; a checkout URL alone is not payment evidence.
9. Only independently verified `COMPLETE` provider status with matching
   amount, currency, ticket and quote permits the existing TEST invoice.
   The invoice line explicitly identifies the **synthetic licence renewal**.
10. Verified TEST invoice moves `fulfilment_state` to
    `awaiting_staff_review` — **never** officially `renewed`.
    Actual regulatory renewal and updated licence issuance require a
    separately approved authority/provider integration, not this POC.

## n8n setup (existing local owner workspace)

Create an n8n Data Table named **`ANCFZ_POC_LICENCES`**, exactly with these
columns:

| Column | n8n type | Example |
|---|---|---|
| `licenceNumber` | string | `ANCFZ-TEST-0001` |
| `companyName` | string | `Example Synthetic Consulting LLC` |
| `licenceStatus` | string | `active`, `expired`, `suspended`, `cancelled` |
| `expiresOn` | string | `2027-06-30` (YYYY-MM-DD) |
| `offeringKey` | string | `renewal_standard_y1` |
| `termYears` | number | `1` |

Import **only synthetic records** from
`infra/n8n/ancfz/ANCFZ_POC_LICENCES.synthetic.csv` using the n8n
Data Tables editor. Do not import real licence/customer records.

Import `infra/n8n/ancfz/07-licence-renewal-lookup.json` as a **new,
inactive** workflow in the same owner workspace. Ensure its webhook node
uses the existing private **ANCFZ - Node to n8n Webhook Header** credential
(`X-ANCFZ-Workflow-Key`), and its Data Table node resolves the exact table
name. Inspect/activate the new lookup workflow only after confirming it
performs **Get row**, never insert/update/delete, and has response errors
covered. It is not exposed publicly through Nginx.

The existing workflow definitions and credentials, including payment and
invoice workflows, should not be overwritten or re-seeded.

## Publishing an approved TEST renewal price

The original `infra/catalog/ancfz-test-2026.json` has a descriptive,
**unpriced** `licence_renewal` offering and does not authorize a renewal quote.

Use the **separate versioned template**:
`infra/catalog/ancfz-test-renewal-2026.json`. It introduces
`create_lead` and `generate_quote` on the renewal intent and five
`renewal_standard_y1` through `renewal_standard_y5` offerings.
**All five prices intentionally default to null.**

A catalog owner must approve the TEST renewal rate for each required term.
For each priced offering, set `price` in the JSON to a positive AED amount
with approved `conditions` and effective date bounds, following the shape
of other priced offerings. Do not copy company-formation rates or fabricate
licence-renewal pricing. An n8n licence record's `offeringKey` must exactly
match a priced renewal offering (for example, `renewal_standard_y1`).

On a controlled local test environment, ensure `ANCFZ_CATALOG_ENV=test`
and the existing Foundry project binding are configured, then explicitly
publish the renewal version using the migration owner's script:

```bash
bash scripts/publish-ancfz-test-catalog.sh --publish-test --catalog=ancfz-test-renewal-2026.json
```

The script refuses to publish this template unless **at least one**
owner-priced renewal offering has a valid positive AED amount and published
conditions. Catalog revisions are immutable: once published, edits require
new `seedKey`, `intentRevision`, `offeringRevision`. Existing tickets
remain pinned to their earlier catalog revision. **Use a new ticket** for
the renewal intent after publication. Never reset PostgreSQL volumes.

## Deployment

The existing migration runner now includes
`015_licence_renewal.sql`; apply it through the normal migration-owner
service before deploying new API code:

```powershell
git switch main
git pull --ff-only origin main
docker compose up -d postgres
docker compose run --rm migrate
```

Check the actual service name in `docker compose config --services`
before using the migration command; this repository currently names it
`migrate`. In `.env`, set:

```dotenv
APP_ENV=development
ANCFZ_RENEWAL_LOOKUP_ENABLED=true
```

Then recreate the API and UI:

```powershell
docker compose up -d --build --force-recreate api web nginx
```

Do not enable this flag in staging/production or expose real licence details
to a public HTTP browser. Production requires authenticated licence-owner
verification, transport encryption, official eligibility and rate authority,
personal-data handling, and regulator/provider renewal fulfilment.

## Tests and gates

```powershell
node scripts/check-licence-renewal.mjs
node scripts/check-natural-action-handoff.mjs
node scripts/check-ancfz-billing-workflows.mjs
```

These are provider-free/offline checks and do not prove a live n8n table,
Salesforce lead, live payment gateway or official renewal integration.
Live acceptance must use only synthetic test records and amounts.
