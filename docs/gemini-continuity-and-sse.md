# Gemini conversation continuity and SSE hardening

## Scope and integrity

Branch: `experiment/gemini-file-search-poc`. The main Foundry application
was reviewed, but not merged wholesale. This implementation preserves the
Gemini single turn worker, 60-minute session expiry, tool allowlist and
independent grounding verifier.

## Model context assembled for every customer message

Node resolves exactly one authorized, active AI session and the ticket-pinned
agent/knowledge/catalog binding. `forModelTurn(scope,ticketId,messageId)`
fetches the current accepted message and **at most 16 preceding messages**,
ordered chronologically. SQL limits `message_sequence` to at or before the
current accepted message to avoid seeing later queued customer messages.
This replaces the old first-500-page read for model turn history, without
changing UI history pagination semantics.

The adapter additionally receives a bounded `sessionContext` JSON snapshot:
- Current selected intent from the ticket's published, pinned catalog
- Customer-stated, verified or disputed facts, with verification status
- Missing requirements and safe action readiness / operation status
- Most recent assistant question as a non-authoritative contextual hint
- Up to 18 **verbatim, length-limited** older customer excerpts

This context is labelled untrusted **data**, not system instructions, verified
business facts, provider results or customer authorization. It never expands
tool permissions or exposes other agents' ticket state. Current ticket facts
take precedence over older statements; corrections are stored authoritatively
through `record_ticket_facts` with customer-message provenance.

## Durable extractive summary

Once more than 16 transcript messages exist, the worker creates a deterministic
`gemini-extractive-summary-v1` snapshot from older customer statements. It
records a monotonically increasing transcript sequence and appends a
revision to existing `ticket_summaries`. Refresh occurs after at least eight
additional older-message ordinals, rather than on every customer token.

No summarization model call is used. No inferred detail from assistant text is
promoted into a customer fact. The summary retains only recent older excerpts
and is **not a complete archival semantic summary**; authoritative ticket
facts, business operations and the full transcript remain in PostgreSQL.
An earlier disputed/corrected customer statement never overrides the latest
saved fact. Existing data access remains agent/ticket RLS-scoped.

## Recover and restart

Browser reload of `GET /api/v1/tickets/:ticketId` now retrieves the **most
recent** 200 authorized messages instead of the first 200, and chronologically
orders them. Older messages remain persisted (a separate paginated UI is not
part of this task). Source download searches exact citations across *all*
authorized assistant messages rather than only a first-page window; normal
File Search evidence verification still applies afterward.

PostgreSQL is authoritative. SSE delivers notification events and reconnects;
the UI reconciles against the authorized ticket snapshot after reconnect.
Native EventSource maintains last-event replay cursor on reconnect. Cached
excerpts and pending tool-call state never grant more than the current
pinned session and customer authorization.

When the 60-minute inactivity boundary expires, a **new ticket and AI
session** are created. Previous customer details are not carried into a
new AI session; retaining the ticket for audit is not cross-session memory.

## Review of latest main SSE changes

**Adopted:** extra subscribed event types, coalesced refresh for lifecycle
state, intent/fact changes, quotations, uploaded documents, payment and
invoice updates. Panels use SSE revision invalidation and an infrequent
60-second recovery poll if an event is missed. The upgrade preserves the
Gemini intent-specific identity checklist and consent policy.

**Not adopted:** the Foundry branch's optional assistant lifecycle
message insertion in lead/payment provider transactions. Gemini already
publishes verified assistant messages and durable SSE events through its
own independent evidence gate. Copying that alternate pathway could
duplicate assistant messages or bypass Gemini response-qualification
auditing. A separate explicit, independently audited Gemini notification
design would be needed before adding assistant lifecycle messages.

## Verification

- Exact-head G0 contracts, API/Next typecheck, Docker build and adapter tests
- Deterministic summary/long-history unit tests
- Disposable PostgreSQL test with 56 synthetic customer messages, corrected
  `visa_count` fact, turn-30 future-turn exclusion, last-17 order, summary
  persistence and session recovery
- G1 live Gemini function continuation/File Search still requires separate
  opt-in; offline CI is not live provider certification
