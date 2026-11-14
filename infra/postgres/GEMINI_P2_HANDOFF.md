# Gemini P2 persistence integration handoff

G0 base: 8078e46e0f55a543d19260acac430c0b4ee14716. No modifications to main, shared
worker, queue, Gemini contracts, Compose, application entrypoint, or manifests.

## Schema inventory

Migration 009: Gemini provider/model ID, Node persona version and instructions,
permitted tools, publication transitions, and explicit unapproved catalog provenance.

Migration 010: gemini_knowledge_versions, gemini_source_documents,
gemini_source_revisions, gemini_knowledge_documents. Source approvals,
document hash, private source references, provider bindings, index status,
publication guard and agent RLS.

Migration 011: ai_conversation_sessions, gemini_response_qualifications,
gemini_response_claims, gemini_response_evidence. Ticket/session identity,
pinned versions, opaque continuation, 60-minute database TTL and response audit.

Migration 012: same-ticket message/source checks and approved File Search,
catalog and verified-operation evidence authorization.

Migration 013: immutable approved/revoked document provenance and one-to-one
qualification linkage to a supported assistant response.

Migrations 001–008 remain unchanged. The migration runner checksums all 003–013
and never resets existing records. All new private tables have FORCE RLS and
composite agent-scoped foreign keys. Runtime cannot administer knowledge.

## Sara / ANCFZ

Sara is version-published under Gemini with an explicit Node persona and exactly
five allowed functions. Knowledge starts NULL with awaiting_publication; no store
resource is fabricated. ANCFZ catalog test publication preserves 21 intents,
97 offerings, 55 priced variants, receipts and history, always UNAPPROVED for
commercial authority. Catalog publication never changes an active agent version.

## Integration-owner handoff

1. Pass GEMINI_MODEL_ID through Compose migrate environment if overriding the
   default gemini-2.5-flash. Remove Foundry-only API startup dependencies.
2. Call GeminiSessionRepository.startNew to create a fresh ticket and AI session.
   Call admitCustomerMessage before model processing; do NOT accept via legacy
   TicketMessageRepository first, as it cannot enforce AI expiry atomically.
3. Use GeminiBindingRepository.forSession (not only version-level pinned) and
   GeminiSessionRepository.recover to reload ONLY session-bound configuration and
   current-ticket messages. No old ticket facts/summaries in a fresh session.
4. Remove provider='foundry' and resp_-prefix assumptions from the integration-
   owned turn queue and worker. Persist opaque state using advanceContinuation.
5. Call P4 independent verifier before factual response persistence/SSE.
   GeminiQualificationRepository.record persists evidence decisions and
attachAssistant links a supported audit to the persisted assistant reply; neither
   not itself authorize streaming. Catalog evidence IDs are intent/<versionId>
   or offering/<versionId>. Verified operations use the operation UUID.
6. P3 must privately preserve originals and normalized text, record approval and
   active indexing, then publish a knowledge version. Bind it via a NEW agent
   version; never mutate an existing published model/knowledge version.
7. Historical tickets and authorized in-flight operations remain after expiry.

## PostgreSQL validation

Run: bash infra/postgres/gemini-p2-validate.sh

The validator overrides every fixed named volume/network and refuses existing test state.
It uses ONLY ai-service-agent-gemini-p2-verify resources; runs
fresh/repeat migration, a checksum tamper negative test, two-agent SQL approval
and RLS assertions, repeat catalog publication, and Node sessions tests against
actual PostgreSQL. It removes the disposable test project afterward. Neither
local Docker execution nor actual provider E2E is implied by committing tests.
