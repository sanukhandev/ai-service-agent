# Intent-driven conversation — Node business authority

**Active experiment:** Gemini model requests the approved Node tool registry. Node owns identity, tickets, intent/offerings versions, durable facts and authorized workflow effects. There is no second conversation planner or model execution path.

## Scope and boundaries

| Concern | Owner |
| --- | --- |
| Natural conversation, clarifying questions and function requests | Gemini model under the published Sara persona |
| Approved business knowledge | Gemini File Search restricted to a published per-agent store |
| Factual response acceptance | Independent Node grounding verifier |
| Intent/requirements and offerings | Versioned PostgreSQL catalogs selected in Node |
| Actual tool execution | Node allowlisted registry in authenticated ticket/session scope |
| Facts, customer corrections, events and ticket lifecycle | PostgreSQL |
| Authorized external side effects | Node preflight, consent, durable outbox and scoped n8n workers |

The only advertised model builtin is `file_search`; arbitrary web/URL tools and direct CRM or n8n execution are forbidden.

## Customer conversation behavior

- **Greeting or clarification:** answer naturally; do not force a catalog lookup or citation.
- **Knowledge question:** answer based on independently verified, approved document evidence (or authorized structured catalog evidence); absent evidence produces a safe clarification or inability-to-confirm response.
- **Customer intent:** use the published `find_intents` and `select_ticket_intent` tools, collect explicit customer facts through `record_ticket_facts`, check `get_intent_requirements`, and retrieve published offerings with `get_offerings`.
- **Consequential action:** Node validates business prerequisites, gathers explicit purpose-specific authorization, commits an idempotent outbox event, and allows a configured n8n worker to execute and reconcile the actual outcome. The model may explain progress but cannot assert completion without provider evidence.

Questions should be determined by missing applicable requirements, not a fixed list or seven-stage prompt. The same ticket can handle a clarification without repeating known customer answers. `customer_stated` facts are not automatically verified facts. Formal prices require approved versioned offering/catalog authority.

## Node function lifecycle

1. Fastify resolves the authorized agent, ticket, active AI session and pinned versions.
2. Incoming customer text and its source message ID are durably recorded.
3. `GeminiTurnWorker` builds bounded session context and exposes only Node-authorized function declarations to the model.
4. Gemini may request `find_intents`, `select_ticket_intent`, `get_intent_requirements`, `record_ticket_facts` or `get_offerings`. Node validates schema, catalog scope and source-message provenance before executing.
5. Bounded function outputs are returned to Gemini using encrypted pending-function state, without allowing cross-agent/session continuation.
6. The candidate answer passes the independent grounding verifier. Unsupported material claims fail closed; supported final replies are committed atomically with events and delivered through SSE.

Current source: `services/api/src/agent/tool-registry.ts`, `intent-tools.ts`, `repositories/intent-adapter.ts`, `runtime/gemini-worker.ts`, and `runtime/gemini-evidence.ts`.

## AI session policy

A 60-minute sliding window begins at the **last accepted customer message**, not a browser ping or assistant message. Refresh/Redis eviction must not change authorized active AI context; expiry starts a fresh AI conversation without carryover. Historical tickets/messages remain under their existing ownership permissions.

## Example

Customer: “I need to register a software services business with one visa.”

Gemini uses the published intent catalog and records the stated business activity and visa count with customer-message provenance. If `shareholder_count` is required for an applicable operation and has not been provided, a natural next question is “Will you be the only shareholder?” When the user requests a formal quote, Node requires an approved catalog price revision and separately authorized request. An n8n receipt alone does not prove that a quotation was delivered.

See [Gemini runtime](03-gemini-and-conversation.md), [workflow policy](05-tools-actions-workflows.md), and [P7 certification status](gemini-p7-status.md).
