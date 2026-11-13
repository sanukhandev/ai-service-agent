# P4 first runtime slice — authorized ANCFZ Salesforce lead via n8n

## Scope and current certification

This slice connects **one** ANCFZ workflow to the Node runtime: `ancfz_salesforce_lead`.
It does not make n8n a ticket creator or a Foundry function tool. Tickets, chat,
intent selection, customer facts, consent and operation outcomes remain in PostgreSQL.

**Disabled by default.** The merged n8n workflow is initially **inactive** with
placeholder credentials. Passing offline CI proves the Node safety controls,
not a Salesforce sandbox Lead or live n8n completion.

The quotation/PDF, OTP, payment-link and payment-verify workflows remain
templates pending their separate Node action gates. Do **not** enable them
through this lead dispatcher.

## Data and authorization

1. Sara identifies a supported intent such as `company_formation` using
   the already-published client function tools.
2. A customer explicitly opens **Request Salesforce follow-up** in the
   Next.js chat. This button is visible only when the operator enables the
   lead dispatcher. Five contact fields are entered by the customer, and
   the separate consent checkbox is mandatory.
3. The **customer-authenticated Node endpoint** checks the ticket owner,
   agent `ancfz`, active intent allowing `create_lead`, typed fields and
   exact consent text. Nothing in a model message can substitute for this.
4. Node writes a single `ticket_operations` row, `event_outbox` record
   and `operation.queued` event in one scoped transaction.
   The unique agent/ticket/operation constraint prevents a second lead
   submission with another request ID. Replaying an identical request returns
   the existing operation; changing the payload requires manual review.
5. A separate, private Node worker claims the operation, calls only the fixed
   URL `http://n8n:5678/webhook/ancfz/salesforce-lead` with a configured
   `X-ANCFZ-Workflow-Key`, and records `operation.running`.
6. Only `{verified:true,status:"verified_completed",ticketId,leadId:"00Q..."}`
   for the matching ticket completes the operation. Ambiguous provider
   responses, HTTP failures, timeouts and expired leases become
   `unknown_outcome` and **are not automatically retried**. This avoids
   accidentally creating duplicate Salesforce Leads when Apex has no
   documented request-id idempotency contract.
7. Ticket events are replayable via the existing SSE endpoint. The browser
   displays the recorded operation state. These events carry no contact
   details; the private outbox contains the submitted fields.

## Before enabling the first live demo

- Review `infra/n8n/ancfz/SEEDING.md` and configure the instance owner and
  `anzfc` project; existing n8n environments need their own backup/review.
- Set a persistent `N8N_ENCRYPTION_KEY` in local, uncommitted `.env`
  (32+ characters) and bring up the backend-only workflow profile:
  `docker compose --profile workflows up -d n8n gotenberg`.
- Verify project-seeded workflow **ANCFZ | Salesforce Apex REST AI Chatbot Lead**
  and edit its `ANCFZ - Salesforce Client Credentials Sandbox` credential.
  Replace `xxxx` with the real sandbox OAuth client ID and secret.
- Set the private Header Auth credential **ANCFZ - Node to n8n Webhook Header**
  to a new random 32+-character secret with header name
  `X-ANCFZ-Workflow-Key`. It must match the Node secret exactly.
- Only **after** verifying the sandbox endpoint, allowed integration user,
  expected Apex response schema and a safe disposable test identity, activate
  that one Salesforce workflow. Do not enable PDF, OTP or payment workflows.
- In your local `.env` set:

  ```dotenv
  ANCFZ_LEAD_DISPATCH_ENABLED=true
  ANCFZ_N8N_WEBHOOK_SECRET=<same-strong-private-header-secret>
  ```

- Restart the API container with the new environment:
  `docker compose up -d --force-recreate api`
  (a rebuild is needed when first pulling this code:
  `docker compose up -d --build api`).

**Do not use real customer identities over the localhost HTTP demo.** Deploy
HTTPS, CSRF protections, a production credential store and Apex-side
idempotency/reconciliation before any public or production traffic.
n8n itself must never publish a host port or be exposed through Nginx.

## Acceptance test

1. With dispatch disabled, the form is hidden and unconsented POSTs return
   HTTP 400. A valid lead consent with dispatch disabled returns HTTP 503.
2. After enabling and verifying n8n, use a **new** ticket with an active
   `company_formation` intent. Enter disposable lead contact details and
   affirm consent in the customer UI.
3. The API returns an `operation.id` and `queued` status; only one
   `ticket_operations` record exists per ticket.
4. Node's API logs show the outcome and an SSE operation event.
5. PostgreSQL owner-only diagnostic query:

  ```sql
  SELECT t.ticket_number, op.operation_key, op.state,
         op.provider_reference, op.provider_status, op.consented_at
  FROM ticket_operations op
  JOIN tickets t ON t.agent_id=op.agent_id AND t.id=op.ticket_id
  ORDER BY op.consented_at DESC LIMIT 10;
  ```

6. The workflow is **verified_completed** only with a real Salesforce Lead ID
   returned from the configured Apex endpoint. If the real response shape
   differs, leave it in `unknown_outcome` and reconcile with Salesforce;
   never fabricate a provider ID or click submit again.

## Remaining P4 work

- Verify the actual Apex endpoint response and implement reliable
  provider-side correlation/idempotency before allowing retries.
- Add signed callback/reconciliation paths and audit/retention controls.
- Implement the independent quotation/PDF, OTP, payment and invoice action
  flows with their own consent and provider-evidence requirements.
- Run live integration tests against n8n and the Salesforce sandbox.
