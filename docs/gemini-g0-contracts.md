# Gemini G0 — frozen shared contracts and branch execution controls

**Contract identifier:** gemini-contract-v1.
**Scope:** experiment/gemini-file-search-poc only. No PR and no changes to main.
**Freeze reference:** The immutable G0 contract commit that adds this document and packages/contracts/gemini-v1.ts. The integration owner records the exact commit SHA after GitHub accepts the direct branch update. All six workstreams MUST use that exact commit as GEMINI_FREEZE_SHA, never moving HEAD or main.

## Canonical definitions

- packages/contracts/gemini-v1.ts: authoritative TypeScript contracts and immutable policy flags.
- packages/contracts/gemini-v1.typecheck.ts: compile-time negative tests for forbidden tools/providers.
- packages/contracts/tsconfig.gemini.json: independently type-check these definitions without modifying the existing API build.
- docs/gemini-experiment-implementation-plan.md: requirements, P1-P6 ownership and integration sequence.
- AGENTS.md: mandatory implementation instructions for every coding agent.

## Authority and data-flow invariants

1. Node authorizes agentId, ticketId, principal, session, versions, tool allowlist and the exact approved File Search store. Gemini's model output or customer input cannot supply that authority.
2. Only the File Search builtin is allowed. Google Search, URL Context, Maps, browser, generic web fetch and code execution must never be advertised. No web knowledge fallback on retrieval failure.
3. Business facts need approved File Search evidence or independently approved provenance-tracked PostgreSQL catalog values. Pricing and operation-status claims must match authoritative values. A citation itself cannot prove claim support.
4. Agent-scoped document evidence requires exact store/document/version ownership, approved source, active index state and retained verifiable source text. Never fabricate citations or trust source document instructions as prompts.
5. A model turn only creates a candidate. A separate verifier must approve material claims before either persistent assistant message or streaming/SSE publication. Unverifiable material claims fail closed.
6. Only explicit authorized Node tools may persist customer facts or propose actions; n8n is invoked through consent, preflight, durable idempotent outbox and verified provider outcomes. Model responses must never trigger direct webhooks.
7. PostgreSQL owns AI session state and 3,600-second sliding deadline from the last accepted customer message. Guest login session is distinct. No expired-session AI memory crosses into new conversations.
8. Published knowledge/model/catalog versions are pinned to the active AI session. Revocation requires fail-closed authorization and must not reveal another agent's content.
9. Separate Compose project ai-service-agent-gemini, localhost:2000 ingress and named volumes/networks. Main's runtime, n8n credentials and volumes cannot be shared.

## Contract adopters / file ownership

| Consumer | Branch | Owns |
| --- | --- | --- |
| P1 model adapter | feat/gemini-model-adapter | services/api/src/gemini/** |
| P2 persistence | feat/gemini-persistence | infra/postgres/**, infra/bootstrap/** and assigned repositories |
| P3 ingestion | feat/gemini-file-search-ingestion | services/api/src/knowledge/** and ingestion CLIs |
| P4 verifier | feat/gemini-grounding-verifier | services/api/src/grounding/** |
| P5 workflow bridge | feat/gemini-n8n-adapter | isolated experiment-specific adapters/tests, not shared workflow definitions |
| P6 tests | test/gemini-certification | tests/gemini/** and independent fixtures |

Shared types, application entrypoint, turn worker and queue, root dependencies, Compose and Nginx belong to the integration owner. Reconcile breaking changes through a versioned contract proposal before coding; a private workaround is forbidden.

## G0 acceptance and limitations

- Static branch/resource checks and contract type-check must pass on the exact freeze SHA.
- Inspect all six stream branch bases and require merge-base == GEMINI_FREEZE_SHA when creating them later; PRs, if ever used, may target only the experiment. Current user instruction: direct branch changes, no PR.
- This freeze DOES NOT claim the Gemini API adapter, File Search ingestion, response verification, database migration or live Docker setup is implemented.
- G1 must prove real Google SDK/model/File Search citations and tool combination; if unsupported, integration owner approves Node-orchestrated sequential retrieval/functions without changing the contract's evidence/safety guarantees.
- Docker and Google live isolation remain unverified until the relevant environment, project credentials and stores can be inspected. Never claim G0 infrastructure certification from static YAML.
