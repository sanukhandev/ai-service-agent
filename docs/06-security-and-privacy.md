# Security and privacy — Node-owned POC

## Trust boundaries

1. Node authenticates and authorizes customer/guest sessions and resolves Agent/ticket from server-controlled state.
2. PostgreSQL is authoritative for transcript, customer facts, catalog versions, consent and authorized operation status.
3. Foundry (Sara) is a conversational decision-maker, **not** a privileged principal. IQ snippets, function arguments, prompts and model messages must not override Node policy.
4. n8n is a private workflow executor. Only a Node outbox worker may submit an **approved** operation, and only provider-correlated evidence may establish completion.

The Angular Admin Portal and Python AI Gateway are not part of this POC. Controlled scripts and versioned configuration publish catalogs/agent bindings until a separate admin milestone.

## Agent and ticket isolation

- Scope all agent-owned rows, blob keys, jobs, Redis keys and SSE events with trusted `agent_id`.
- Composite foreign keys/RLS block cross-agent relational references. Node must run under a **non-superuser** PostgreSQL role, without `BYPASSRLS`, with a transaction-local agent context; never use the migration owner as runtime user.
- The Node tool registry gets trusted context from the authenticated session. It rejects model-supplied `agentId`, `ticketId`, workflow endpoints and provider credentials.
- A function request cannot bypass tool grants, input validation or preflight. Model-controlled context is never an authorization token.
- Native Foundry IQ retrieval is configured on the published Foundry agent; review Azure resource/identity and knowledge attachment for separation from other Agents.

## Email OTP and customer sessions (P5)

- Guest tickets use opaque scoped sessions and rate limiting.
- Node performs email verification in a secure UI; hashed OTP challenge, expiry, attempts and replay protection. **Never send OTP, passwords or tokens to Foundry, model prompts, ticket chat or logging.**
- Protect user existence from enumeration and bind tickets to verified owner or guest token.
- Require meaningful customer consent for lead creation, formal quote submission, disclosure and external notifications.
- Do not collect personal details merely to answer general information requests.

## PII policy

Since the **Python Model Gateway is removed**, don't add Presidio as a reason to reintroduce Python. Implement a small Node privacy adapter in P5; if contextual PII detection is necessary, evaluate **Azure AI Language PII** as an optional external provider. Prefer data minimization, secure structured fields, log masking and role-scoped access.

No detector catches every PII value. In particular, don't blindly remove legitimate customer contact details needed for an explicitly approved CRM operation. Do not expose sensitive identifiers in screenshots, logs, model tool outputs or customer-visible URLs.

Private customer documents belong to authorized ticket-scoped Azure Blob Storage, not to the shared Foundry IQ RAG source. Validate file signatures, sizes, access and OCR extraction provenance.

## Azure auth

Local POC uses `@azure/identity`'s `AzureCliCredential` **inside the Node API**; P1 adds Azure CLI to the Linux Node runtime image. Mount the private `azure-cli-auth` named volume only there and use `AZURE_CONFIG_DIR=/home/app/.azure`. An authenticated Azure CLI session may survive rebuilds but can require interactive renewal. Never commit cached credentials, copy them into image layers, or mount the Windows CLI cache into a Linux container. Managed identity is for deployed environments.

The published Foundry agent/version, configured IQ knowledge and allowed function schemas are trusted versioned configuration. Neither the browser nor the model can select an arbitrary project endpoint or update the agent.

## Network

- Only Nginx publishes port 80; every other service is Docker-internal.
- There are no public `/admin/`, `/n8n/`, `/ai-gateway/` or database endpoints.
- HTTP is allowed **only for localhost or isolated POC testing**; any real customer credentials, OTP, PII or uploads require upstream HTTPS before internet exposure.
- Keep n8n credentials server-only; callback authorization/signatures and replay denial are required even on a private network.
- Use strict same-origin browser API access, secure cookies where applicable, input-size bounds, appropriate CSP and redacted trace IDs.

## Deferred H1 audit

After the working POC, automate isolation tests, customer session/OTP tests, prompt injection and PII tests, n8n callback/replay checks, RLS/revocation checks and token leakage scans. **Do not defer implementing the underlying protections** simply because test automation is postponed.
