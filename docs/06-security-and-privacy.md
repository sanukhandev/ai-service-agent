# Security and privacy — Gemini experiment

## Trust boundaries

1. **Node owns authority:** browser input, model-generated tool calls, retrieval excerpts and n8n results never confer agent ownership, authorization, customer consent or document publication rights.
2. **PostgreSQL owns durable state:** agents, tickets, messages, session deadlines, published catalogs, approved source versions, actions, evidence and events.
3. **Gemini generates candidates only:** source-grounded business claims must pass the independent Node verifier before persistence or SSE publication.
4. **n8n executes authorized operations only:** Node uses scoped consent, preflight, durable outbox and independently verified provider callbacks/results. An HTTP response alone is not proof of business completion.

## Agent and ticket isolation

- Derive `agent_id`, ticket ownership and pinned model/knowledge/catalog permissions server-side.
- PostgreSQL tenant-like isolation is agent-scoped through composite foreign keys and transaction-local RLS with a non-superuser `agent_runtime` login. A model-provided ticket ID or external store URI is never sufficient authorization.
- Keep agent knowledge bindings published/versioned. Only the explicitly authorized File Search store may be advertised; no browsing, Google Search, URL Context or arbitrary file/URL tools.
- Confirm exact approved document identity and content digest (or approved structured catalog evidence) before accepting material claims. Revoked or ambiguous sources must fail closed, including after publication.
- Scope Redis keys, original-document storage, signed callbacks, workflow bindings and SSE replay by trusted agent/ticket identity.

## Sessions, OTP and credentials

- The **AI session** lasts 60 minutes since the most recent accepted customer message. Expiry creates a new AI context; no cross-session transcript or model continuation may be silently imported.
- Guest/customer authentication is separate from AI session expiry. Rate-limit OTP, protect against enumeration, hash challenges and prevent replay. Never put OTPs, passwords, access tokens or provider secrets into the model prompt or customer chat.
- Keep `GEMINI_API_KEY`, 32-byte hex `GEMINI_STATE_ENCRYPTION_KEY`, PostgreSQL migration owner password and restricted runtime password distinct and private. Pending Gemini function state is encrypted in PostgreSQL and bound to agent/session scope.
- Do not commit `.env`, cloud identifiers containing secrets, customer data, API call bodies, private originals or n8n credential exports. Log redacted correlation IDs and controlled error types only.

## Knowledge and uploaded documents

Administrator-approved source originals and normalized extractable text are retained privately with immutable SHA-256 and version provenance. Indexing a document is not authorization to publish its content. Customer-uploaded ticket documents are private ticket artifacts and must **not** silently become agent-wide Gemini File Search knowledge.

The ingestion pipeline handles supported normalized TXT/MD/DOCX and text-extractable PDF. Image-only scanned PDFs need separate approved OCR and verified text before being used to ground factual answers. Validate file path containment, type, size, digest, source approval and download ownership.

## PII and network safeguards

Collect personal information only for the user's requested service/action. Protect structured contact information and transcripts through authorization, restricted storage and selective log redaction; optional external PII services are not a substitute for access control.

Only experiment Nginx publishes `127.0.0.1:2000:80` on the host; other containers stay internal. The localhost HTTP endpoint is **not suitable for public real-customer PII, identity documents or OTP handling**. Require TLS, hardened cookies, appropriate CSP, rate limits and independent review before external deployment. The optional n8n editor must not expose direct public webhook execution.

## Security acceptance

Automated policy/RLS/offline tests have passed at documented commits, but the full local/live P6 security matrix is not certified. Remaining checks include cross-agent leakage, source revocation, prompt injection, tool argument escalation, encrypted continuation replay, provider callback forgery, consent/idempotency, credential leaks and repeated failures under restart. See [P7 status](gemini-p7-status.md).
