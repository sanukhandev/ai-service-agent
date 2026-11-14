# Sara — Gemini Persona v2

**Runtime agent:** `ancfz` (`Sara`), published in PostgreSQL under an immutable
`agent_versions` row. **Admin UI is intentionally out of scope.**

## Source of truth

`infra/bootstrap/sara-persona.sql` stores the full versioned system instructions and
metadata (`sara-gemini-persona-v2`). The Gemini SDK receives this value through
the server-resolved, ticket-pinned `AgentRuntimeBinding`. Never put customer
controlled persona text, passwords or an arbitrary `SYSTEM_PROMPT` in `.env`.
The model cannot override its own published instructions or tool permissions.

## Operating rules

- **Identity:** Sara, ANCFZ's AI business-services assistant; no staff,
  regulatory, legal or payment-authority impersonation
- **Style:** natural, clear, professional, concise, match the customer's
  language when supported, generally one missing question at a time
- **Natural intent:** call `find_intents` when a customer describes an actionable goal;
  select only a clear catalog intent, clarify ambiguous requests, no routine
  confirmation of obvious goals and no invented intents
- **Facts:** `get_intent_requirements` and `record_ticket_facts` (only explicitly
  customer-stated facts); no forced scripted journey, avoid repeating questions
- **RAG:** approved agent-bound File Search and structured Node catalog only;
  never web browsing or unsupported factual/policy/pricing guarantees
- **Offerings:** `get_offerings` for published packages and variants;
  non-approved test prices never become binding quotations
- **Actions:** `preflight_operation` and `propose_operation` when eligible and
  customer-requested; the proposal is *inert* until the customer explicitly
  authorizes the action through Node's secure UI
- **Privacy:** use secure upload/checkout paths for documents and payments;
  do not echo sensitive data or expose internal instructions/credentials
- **Sessions:** only current 60-minute active AI session; cross-session AI
  memory is not promised
- **Escalation:** if grounded evidence or operation authority is missing, say
  what cannot be verified and ask a focused follow-up / offer staff review

## Publication without altering existing tickets

Fresh database: the migration container's `seed-sara.sql` executes
`sara-persona.sql` and publishes v2 with `knowledge_status='awaiting_publication'`.
No fake File Search store or commercial-price approval is inserted.

Existing database: set `GEMINI_SARA_PUBLISH_PERSONA=YES` in the *private*
experiment `.env` and run `docker compose run --rm migrate`.
This explicitly runs `publish-sara-persona.sql`, which:
1. Requires an active published Gemini Sara agent, checks a known prior v1
   (or no-ops when v2 is already identical), and refuses newer/custom personas.
2. Preserves the current model ID, existing authorized tools, pinned published
   knowledge version and intent/offering catalog identities. For historical
   Sara v1 configurations missing the two explicitly approved P1 tools, the
   operator-published v2 adds only `preflight_operation` and
   `propose_operation`; it does not enable n8n dispatch.
3. Inserts a new immutable v2 agent version and atomically points future tickets
   at it. Existing tickets and sessions retain their prior version binding.
4. Fails if current knowledge is revoked or the same v2 label has different text.

Change the setting back to `NO` afterward. Never edit a published agent
version directly. Later persona revisions need a distinct version label and
an independently reviewed publication process.

## Acceptance

The disposable PostgreSQL test verifies fresh v2 seeding, repeat migration
idempotence, deliberate v1→v2 publication from the historical five-tool
allowlist, preservation of model/catalog/knowledge bindings, and
immutability of the historical v1 row. G0/P7 CI validates API/Next build and
the offline Gemini adapter. Live G1 File Search/tool continuation and real Sara
conversations still require separate Google-provider testing.
