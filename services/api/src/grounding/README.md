# Independent Gemini grounded-response verifier

`services/api/src/grounding/index.ts` is a read-only, fail-closed claim/evidence verifier using frozen Gemini v1 response types. It is **wired into** the sole `GeminiTurnWorker` through the `resolveGeminiEvidence` adapter. Gemini output is a candidate; a material factual assertion may be persisted and emitted by SSE only after Node verifies its independently approved evidence.

## Evidence authority

- **Document evidence:** exact authorized agent/session/knowledge/document/version identity, human approval, active indexed state, retained original/normalized text and SHA-256 integrity. Citation title or snippet alone is insufficient.
- **Catalog evidence:** only approved, source-traceable, pinned commercial/catalog revision. The ANCFZ source-derived test catalog is not commercial approval.
- **Operation evidence:** independently verified final provider outcome. An n8n acceptance/HTTP acknowledgement or a model claim cannot establish successful lead, quotation or payment.

The verifier does not call Gemini, invoke business tools, fetch the web, create/update knowledge, or persist responses. The runtime loads its inputs from scoped PostgreSQL/private approved originals, executes `verifyGrounding`, and commits a qualified answer or safe fallback with the associated audit/events. If knowledge is available and the initial candidate is unsupported, the worker may perform one knowledge-only generation and rerun verification; the unqualified first candidate must never be streamed.

## Limitations

The built-in deterministic verifier is conservative rather than a general semantic entailment model. It checks material claims, number/currency/term signatures, negation and required qualifiers but may reject valid paraphrases or be vulnerable to complex constructions outside its rule set. A future semantic verifier requires separate quality/security certification. No lexical-percentage overlap bypass is permitted. Retrieved documents may contain prompt injection and are treated as untrusted data.

A green offline golden test demonstrates only the tested cases. **Full live Gemini/File Search mapping, unsupported-claim escape rate, false-rejection rate and cross-agent revocation certification remain pending.**

## Offline test

```bash
npm run build --workspace @ai-service-agent/api
node --test services/api/src/grounding/__tests__/grounding.test.mjs
```

See [runtime architecture](../../../../docs/03-gemini-and-conversation.md), [P7 status](../../../../docs/gemini-p7-status.md) and [P6 certification harness](../../../../tests/gemini/README.md).
