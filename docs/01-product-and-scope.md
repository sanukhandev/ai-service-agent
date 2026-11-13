# Product requirements and scope

## Purpose

Build a configurable platform hosting business assistants. **Sara / ANCFZ** is the initial integration: visitors ask about approved free-zone knowledge, explore company formation options, receive explanations, and later request authorized lead/quote operations.

The platform must support a second unrelated business by creating a new **Agent configuration**, not by copying code or adding agent-specific branching.

## Personas

- **Guest customer:** asks general questions, starts a ticket, optionally supplies context and uploads documents.
- **Authenticated customer:** owns agent-scoped tickets and can resume interactions after email OTP.
- **Administrator:** manages agent bindings, persona, published catalogs, knowledge references, permitted tools, workflow bindings and tickets.
- **Operator:** inspects failures and verified workflow state. RBAC must be server-side.

## Functional scope

1. **Agent selection:** resolve a public agent alias to a server-owned `agent_id`, an active Foundry project/name/version and catalog revision.
2. **Conversation:** accept customer messages, create/resume a ticket, retrieve authorized context, invoke Foundry and deliver grounded replies. Greetings do not need RAG.
3. **Knowledge:** the Foundry agent uses its connected Foundry IQ knowledge base. Explain factual business answers from actual retrieved source evidence; never invent formal prices or policies.
4. **Goal identification:** interpret customer goals from the entire conversation. Once application tools exist, use a versioned intent/requirements catalog. Do not impose a fixed stage sequence or demand routine goal confirmation.
5. **Offerings:** list relevant services, packages, eligibility and approved prices from a structured offerings catalog when available. RAG-only descriptions are informational, not formal quotes.
6. **Ticket persistence:** store transcript, authenticated/guest ownership, subject, status, facts, action history, source references and events. Ticket numbers come from Node, never the model.
7. **Customer identity:** optional email OTP flow in secure HTTP UI. The same email may map to distinct agent-scoped accounts. No OTP or credentials in chat.
8. **Private documents:** securely upload to agent/ticket-scoped storage; OCR/extract via Azure Document Intelligence when implemented; do not publish customer uploads to shared IQ.
9. **Operations:** propose and explicitly authorize business actions (e.g. `create_lead`, `generate_quote`). Node verifies prerequisites/consent and dispatches n8n with idempotency.
10. **Admin:** simple UI for agent management, catalogs and ticket/workflow visibility.

## Natural interaction rules

- Directly answer the current question. Ask one relevant follow-up only when necessary.
- For "tell me more", add sourced detail instead of repeating generic FAQ content.
- Do not invent available packages, office types, prices, status or source citations.
- Do not claim "not in the knowledge base" after one unsuccessful search; report the detail as unverified.
- Do not request an email or document to answer a basic informational question.
- Explicit customer confirmation is required for consequential actions and deliberate ticket closure, **not** for recognizing every goal.

## Out of scope for initial vertical slice

Payment execution, public external web browsing, agent-specific hardcoded journeys, application-hosted embeddings, production-grade identity hosting, separate tenant organization data model, full visual workflow designer, custom LLM reasoning engine, complex animation/UI framework.

## Nonfunctional requirements

- Scope every agent-owned operation by trusted `agent_id`; cross-agent access must fail.
- PostgreSQL remains authoritative even when Redis/Foundry/n8n are degraded.
- Bounded timeouts, retries, concurrency and typed failures; no phantom success.
- Only Nginx publishes port 80; HTTP must not be publicly exposed for PII.
- Accessibility: semantic HTML, keyboard controls, visible focus, explicit labels/errors.
- Observability: correlated request/ticket/Foundry IDs without secrets or raw OTP.
- Document completion criteria in [testing](09-testing-and-acceptance.md), rather than declaring production readiness from mocks.
