# Security, privacy, identity and PII

## Security boundaries

There are three separate decisions:
1. **Who is the caller?** Node authenticates guest/customer/admin/service identity.
2. **Which Agent/ticket can they access?** Node enforces scoped authorization, backed by PostgreSQL constraints/RLS.
3. **What can happen?** Node authorizes read tools, proposals, consent and state changes independently of model text.

The model is not a trusted principal. A Foundry function call, RAG excerpt, provider message or retrieved document cannot grant privileges.

## Agent isolation

- Resolve `agent_id` from a trusted route/session binding and authorized configuration, never accept cross-agent model or browser-supplied IDs without verification.
- Apply `agent_id` to PostgreSQL, Redis keys, blobs, job records, action evidence, admin queries and ticket identifiers.
- Keep published Foundry agent/version and knowledge source references explicitly associated with each application agent. Native IQ MCP retrieval is not mediated by Node, so enforce its isolation through Azure resource configuration and identity permissions.
- Require service authentication between Node and Python, and signed/provider-authenticated n8n callbacks, even on the internal Docker network.

## Customer authentication and OTP

- Guests can ask public questions with rate limits and scoped guest tickets.
- Account creation/linking uses Node-controlled, agent-scoped email verification with a secure form, not chat.
- Challenge stored hashed with TTL, attempt count and throttling; never log or pass OTP to model.
- Respond uniformly to account existence checks to avoid enumeration.
- Use secure, HTTP-only session cookies with same-site protection where supported; HTTPS is mandatory for public use.
- Customer consent for lead or quote is purpose-specific, recorded and revocable where applicable. Ticket closure requires explicit customer instruction plus server validation.

## PII policy with Presidio

Install and configure `presidio-analyzer` and `presidio-anonymizer` in the Python gateway. This is a **detection component**, not a complete privacy boundary or guarantee.

- Detect names, emails, phone numbers and jurisdiction-appropriate identifiers with configured NLP rules/models.
- Distinguish required business data from incidental PII; redact/mask incidental values before they enter model context.
- For approved operation inputs, Node keeps authoritative structured values and controls their use. Don't destroy required contact information by indiscriminate anonymization.
- Reversible placeholders must be scoped to one authorized ticket/session, mapped outside model-visible content, and never swapped between customers.
- Redact logs, trace attributes, test fixtures and error messages independently of conversational PII detection.
- Encrypt regulated/sensitive DB fields as needed and keep private customer docs in restricted blob storage.
- Presidio does not reliably catch all PII, especially ambiguous names, IDs, multilingual text and non-text documents. Test representative content and fail safely.

## Foundry and Azure credentials

Local POC: Python uses `AzureCliCredential` and a private Linux container cache in a Docker named volume. Credentials must not appear in environment dumps, logs, git, container build layers, browser bundles or sample .env files.

The agent's published version, project endpoint, knowledge source and allowed tools are **trusted admin configuration**. Validate Azure identity/RBAC and live tool calls; a created agent may still be unable to retrieve.

Use managed identity or workload identity for later Azure deployments. Do not use a developer's Azure CLI login for shared or public production workloads.

## Browser/deployment policy

- Only Nginx exposes host port 80. Backends, databases, Redis, n8n and AI gateway remain private to Docker.
- HTTP port 80 only on localhost or a controlled test network. Do **not** transmit real passwords, OTP, PII or uploaded customer documents on publicly reachable unencrypted HTTP. Put an HTTPS load balancer/ingress upstream before external access.
- Limit uploads by MIME allowlist, file signature, size, scanning policy, blob path and authorization; never execute uploaded content.
- Restrict CSP where compatible with fonts/assets, use same-origin API calls, avoid broad wildcard CORS and protect admin routes with server-side RBAC.
- Google Fonts: use bundled/self-hosted Inter to avoid third-party requests from customer browsers where feasible.

## Threat test checklist

- Cross-agent ticket UUID and foreign-key references fail.
- Unverified users cannot read transcripts or account existence.
- Brute-force/rate-limited OTP and OTP replay denied.
- Untrusted tool arguments cannot choose another agent, provider URL or ticket.
- Prompt injection in retrieved knowledge cannot call actions or reveal secrets.
- n8n success cannot be forged from HTTP acknowledgment; callbacks reject replay and mismatched execution IDs.
- SSE cursors replay only authorized ticket events.
- Raw PII and secrets absent from app logs, traces, exceptions and committed fixtures.
- Foundry tool permissions verified in live calls, not inferred from portal labels alone.

Record risks explicitly if POC tradeoffs are accepted. "Guardrails not configured" never means authentication, privacy, data isolation or action authorization are optional.
