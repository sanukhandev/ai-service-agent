# Intent-driven conversation — Node-only business authority

Status: **approved architecture and partial Node scaffolding**. The Node function registry, intent handlers and function-loop contracts exist. PostgreSQL adapters, the live Foundry SDK call/continuation, agent version publication and n8n workflows are not integrated yet.

## Ownership contract

| Concern | Owner | Never owned by |
|---|---|---|
| Natural dialogue, which tool to ask for, conversational tone | Published Foundry agent GPT-5.4 | Fixed dialog scripts |
| Descriptive knowledge retrieval | Native Foundry IQ tool attached to agent | Custom Node/Python RAG pipeline |
| Published service intents/requirements, offerings and price revisions | Node + PostgreSQL | Foundry IQ as unstructured authority |
| Tool registry, schemas, tool permission checks and execution | Node | Browser, model or n8n |
| Customer facts, ticket selected goal, source references, corrections, history | Node + PostgreSQL | Foundry-only ephemeral memory |
| Action eligibility, proposals, consent, durable outbox and provider status | Node | Model assertions |
| CRM, quotes, external integration effects | n8n after **Node authorization** | Direct model tool call |
| User-interface chat, consent, OTP and documents | Next.js through Node API | Foundry playground |

No direct model-exposed \`execute_workflow\`, arbitrary URL, CRM mutation or \`n8n_trigger\`. Even \`propose_operation\` only creates a non-executing proposal in Node.

## Four categories of turns

1. **Greeting/small talk:** answer normally; no intent catalog or RAG required.
2. **Information:** use Foundry IQ for FAQ, rules, license procedures and business facts. Answer first; do not demand a lead.
3. **Customer goal:** use \`find_intents\` to discover configured services; \`record_ticket_facts\` to save explicit details; \`get_intent_requirements\` to find the next relevant missing question; \`get_offerings\` for published catalog prices.
4. **Consequential action:** on explicit customer request, \`preflight_operation\` -> \`propose_operation\`, then **separate authenticated customer approval** -> Node outbox -> n8n -> verified provider evidence.

## Why this is more natural than a FAQ bot

Foundry IQ has good prose about ANCFZ, but cannot reliably choose which external workflows are allowed, tell whether a customer's field is already collected, or assert whether a CRM lead actually exists. The **Node catalog describes services and executable business rules**. The model uses it to decide *which question actually helps this user*.

Sara is not required to follow the order in the catalog. Requirements declare prerequisites for a named operation, not the order of questions. A model can answer pricing first, then ask about shareholder count, while Node consistently tracks all provided fields.

Good answer pattern: **acknowledge the person's current aim -> use known facts -> give a grounded helpful answer -> one meaningful question or next step**.

Avoid mechanical "Here are 12 facts" responses, repeated FAQ summaries, multi-question interrogations, and ungrounded promises. See [service employee prompt](../services/api/prompts/sara-service-employee.md).

## Tool loop inside Node

For a published Foundry agent version, register **function descriptions** alongside the existing native IQ knowledge tool (via supported Foundry SDK/REST provisioning). Node stores actual handler implementations.

On each accepted customer turn:
1. Resolve agent/ticket/guest ownership, pinned agent/catalog version and allowed tools in Node.
2. Persist customer message **before** model inference.
3. Load ticket summary, recent messages, selected intent and verified/customer-stated facts from PostgreSQL. Build bounded context.
4. Call the pinned Foundry agent (no new agent creation). Native IQ retrieval happens within Foundry when selected.
5. If Foundry yields an application function call, validate name/JSON, enforce agent tool allowlist, attach **trusted Node context** and execute registered handler locally.
6. Submit the output back to the **same Foundry conversation** as a \`function_call_output\`, and resume model inference. Repeat with a bounded call/round budget.
7. Persist final reply, source references, events and any proposed non-executing action. Deliver via SSE.
8. On unsupported tool/timeout, return a typed error and a safe customer response, not invented data.

The source scaffolding is:
- \`services/api/src/agent/tool-registry.ts\`
- \`services/api/src/agent/intent-tools.ts\`
- \`services/api/src/agent/function-loop.ts\`

The first registered tools in code are \`find_intents\`, \`get_intent_requirements\`, \`record_ticket_facts\` and \`get_offerings\`. **No direct n8n function is registered.** Read tool handlers depend on \`CatalogRepository\` and \`TicketFactRepository\` implemented against PostgreSQL in P2/P3. The model cannot select \`agentId\` or \`ticketId\`.

## Ticket fact persistence

Suggested normalized tables:
- \`ticket_intents(agent_id, ticket_id, catalog_version_id, intent_key, status, selected_at)\`: selected/current goals; preserve historical changes.
- \`ticket_facts(agent_id, ticket_id, intent_key, requirement_key, value, verification_status, source_message_id, updated_at)\`: current customer statements and verified facts, each scoped by agent and ticket.
- \`ticket_fact_events(agent_id, ticket_id, fact_id, old_value, new_value, source_message_id, created_at)\`: corrections/audit.
- \`intent_catalog_versions\`, \`intents\`, \`intent_requirements\`, \`offerings\`, \`offering_price_revisions\`: published definitions and prices.

Use agent-scoped composite FKs, RLS, transaction-local context and ownership validation. The \`record_ticket_facts\` repository adapter must ensure that \`source_message_id\` references an actual customer-authored message on the current ticket. Customer-stated fields are **not** automatically independently verified, even when accepted for conversational planning.

A simple summary/rolling context should provide:
\`\`\`json
{
  "selectedIntent": "company_formation",
  "knownCustomerFacts": {
    "business_activity": "software services",
    "visa_count": 1,
    "office_preference": "shared office"
  },
  "missingForCompanyStructure": ["shareholder_count"],
  "availableActions": ["create_lead", "generate_quote"]
}
\`\`\`

The context is assembled in Node from durable state. Never use the entire conversation transcript as a permanent prompt; rolling history/summaries avoid quota exhaustion.

## Configuration example — ANCFZ

Use a published, agent-scoped catalog row for \`company_formation\`:
- Description: Starting/registering a new company.
- Intent examples: "open a software company", "register my business", "get a business license".
- Requirements: \`business_activity\`, \`shareholder_count\`, \`visa_count\`, \`office_preference\`.
- \`customer_email\` is **only required for a consented lead/notification**, not for answering setup questions.
- Allowed actions: \`create_lead\`, \`generate_quote\`.
- Offerings/price revisions are separate and must be verified before formal quotes.

**Dialogue example:**

Customer: "I want to start a software business, with one visa and shared office."

Node records explicit \`business_activity\`, \`visa_count\`, \`office_preference\` as customer-stated. Sara finds the published goal and asks: "Will you be the only shareholder, or will you have partners?"

Customer: "It's just me."

Node updates \`shareholder_count = 1\` with the new message source. Sara can now explain the likely FZE company structure, using IQ for descriptions and the structured catalog for offerings.

Customer: "Please send a formal quote."

Sara checks prerequisites. Node proposes an exact quote with approved pricing terms. The **customer authorizes it separately** in the secure UI. Only then does Node queue an n8n job. A workflow submission acknowledgment is not proof of completed quote delivery.

## Implementation sequence

- **P1**: Node Foundry SDK/credential adapter, register function definitions while retaining Foundry IQ, integrate bounded function loop.
- **P2**: PostgreSQL ticket persistence, fact/event repositories and Node-managed rolling context.
- **P3**: Versioned intent/requirement/offering tables, publish catalog, connect read and fact tools, implement semantic-assisted discovery with bounded candidates.
- **P4**: Non-executing proposal, explicit approval endpoint, authorized outbox/worker and n8n result verification.

Keep this ownership contract true even when the POC postpones automated tests and admin UI.
