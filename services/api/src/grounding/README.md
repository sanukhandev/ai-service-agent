# P4 — Gemini approved-source response verifier

`index.ts` exports an **independent, read-only, fail-closed** Node verifier. It consumes the frozen G0 `gemini-v1.ts` response types. It does not call Gemini, retrieve a File Search store, mutate knowledge, persist messages, or dispatch n8n actions.

## Integration-owner invocation

After Gemini produces `ModelTurnCandidate` and after Node loads the authenticated agent/session/approved sources, but **before** inserting any assistant message, writing an `agent.response.completed` event, or sending any SSE chunk:

```ts
const decision = await verifyGrounding({
  candidate, agent, session,
  documents: await loadVerifiedSourceTextForAnnotations(agent, candidate.sourceAnnotations),
  catalogs: await loadApprovedSourceTraceableCatalog(agent, session),
  operations: await loadVerifiedOperationOutcomes(agent.agentId, session.ticketId),
  budgetMs: 750,
});
if (!canPublishCandidate(decision)) {
  // Record private failure/audit metadata; do not stream or save the candidate.
  // Optionally request at most ONE read-only evidence-constrained rewrite and re-run P4.
  // Never re-run tool calls or n8n actions during answer repair.
  return neutralUnavailabilityOrClarification(decision);
}
// Now and only now: commit verified candidate + private evidence decisions and emit SSE.
```

The functions above are **integration-owner placeholders**, not exported functions. Node must obtain all records from authorized DB/knowledge repositories; do not accept these arrays from the browser, Gemini, or function-call arguments. This module is not the persistence/retrieval implementation. If source originals or independently extracted normalized text are missing, factual responses fail closed. Never use provider annotation `excerpt` as the trusted text.

## API

- `verifyGrounding(input: GroundingInput): Promise<GroundingDecision>` — G0 status/category/claims plus private source evidence IDs. `supported` is the only publication-eligible status.
- `canPublishCandidate(decision: GroundingDecision): boolean` — explicit publication gate.
- `SourceRecord` — G0 `ApprovedDocumentEvidence` plus trusted original/normalized `verifiedText` and integrity digest, with failure states for rejection.
- `CatalogRecord` — independently published, source-traceable approved catalog entry, authoritative statement and optional structured exact facts. A synthetic/test catalog without commercial approval is NOT eligible.
- `OperationRecord` — G0 `AuthorizedActionOutcome` plus a separate independently verified final completion flag and statement. 202 acknowledgments and uncertain outcomes are not success.
- `SemanticVerifier` — optional injected, read-only evidence-constrained entailment callback with deadline/abort. Never provide unrelated conversation, tools, secrets, web access or external retrieval to this callback.

The default deterministic verifier recognizes a deliberately limited synonym vocabulary and requires complete material-token support, exact normalized number/currency signatures, matching negation and mandatory qualifiers. It does not apply a 70%-overlap threshold. Unsupported phrasings conservatively abstain; a broader NLI/semantic entailment backend must be independently evaluated before production. Source instructions are treated as data and filtered from supporting passages.

## Known limitations / integration blockers

1. Deterministic sentence/clause parsing is **not a general semantic entailment proof**. It may reject legitimate complex paraphrases or accept adversarially arranged words that pass the finite rule checks. The optional NLI callback also requires independent quality/security certification. Do not claim this proves zero hallucinations beyond the measured golden corpus.
2. `SourceRecord.verifiedText` and checksums must originate from trusted original-file extraction and be checked against private source provenance by P3/P2. A hash of text supplied by the model is not authority. `CatalogRecord` provenance/approval must come from a verified PostgreSQL join, not an untrusted JSON payload.
3. P4 does not create data-loading repositories, expose routes, or intercept token-level streaming. Integration owner must buffer complete Gemini responses until P4 passes and persist evidence decisions transactionally with accepted assistant messages/events.
4. All calls must pin G0 agent, published knowledge version and both catalog versions to the active, nonexpired session. Do not silently switch to a newer store mid-turn.
5. The G0 contract lives outside the API's existing TypeScript `rootDir`. A narrowly scoped `@ts-ignore` on the *type-only import* preserves current API compilation without touching the integration-owner tsconfig. Integrator should harmonize monorepo project references/paths in a coordinated shared build update.
6. Live Gemini model/file-search source-annotation mapping, Google store ingestion, PostgreSQL evidence joins, runtime publication wiring, Docker and n8n E2E were not exercised by these offline tests.

## Offline test run

From repository root, after installing workspace dependencies:

```sh
npm run build -w @ai-service-agent/api
node --test services/api/src/grounding/__tests__/grounding.test.mjs
```

Tests contain an invented, nonproduction golden source corpus. They cover social/clarification, entailment/paraphrase, mixed claims, source forgery, isolation/revocation/indexing/version pinning, structured price/visa terms, source injection, verifier exceptions/deadlines, operation acknowledgment vs completion and catalog approvals. The test command uses only Node's built-in test runner; no live Gemini credentials/network are required.
