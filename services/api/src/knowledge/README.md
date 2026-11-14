# P3 — Gemini File Search knowledge publication

**Scope:** This module owns ingestion and publication decisions, not the P2 tables or the P4 semantic claim verifier. Sara is a sample agent; the code accepts arbitrary trusted agent UUIDs. The built-in Google adapter uses the Gemini Developer API `v1beta`; credentials are injected at runtime and never logged. Build `services/api` before running the CLI; the commands load its compiled `dist/knowledge/*.js` modules. Node 22+ is supported.

## Policy

- Customer ticket attachments are not eligible; an authenticated administrator must explicitly supply, review and independently approve a knowledge source. Approval must be returned by `KnowledgeRepository.requireApproval` using a trusted human-review record; CLI input is not approval.
- The P2 adapter owns immutable source approval records, agent scoping, transactional CAS publication, session pin checks, and revoke-before-retrieval enforcement. No in-memory/mock fallback is used by operator CLI. The integrated PostgreSQL repository adapter supplies this boundary; verify its authorization and indexed provider evidence in the target environment.
- The publisher retains originals in a private, mode-0700 agent/version tree. Use private encrypted volume/object storage with authorized P4 read access and backup/retention policies. Do not point this vault at a ticket-upload directory.
- Files supported: PDF, DOCX, UTF-8 TXT and Markdown, with exact MIME validation, PDF signature/EOF, DOCX structural ZIP checks, ZIP entry CRC/size/traversal/symlink/bomb protection. Archives are disabled unless `KNOWLEDGE_ENABLE_ARCHIVES=true`, and CLI validation and `submit` expand enabled archives safely into individual, unapproved source records, each requiring an independent approval. Scanned PDF OCR is not provided.
- One provider store per knowledge version, with exact server-owned store/document IDs. File Search is the only retrieval tool. Source document text is never promoted into agent instructions. No synthetic chunking, embeddings, pgvector or web fallback.
- The expected P2 adapter must satisfy `KnowledgeRepository` and implement atomic compare-and-swap binding publication, current binding and pinned active-session checks with RLS. Required documents must all be approved, indexed, active, mapped and pass both positive and negative retrieval smoke. Publication failures cannot change the live binding.
- After publishing a replacement, the previous store and pinned sessions remain intact. Revocation writes a fail-closed deny state in P2 before any asynchronous provider cleanup. Delete only with the explicit `purge` confirmation after pinned sessions, provider inventory and audit retention have been checked. P2 audit rows are not removed.
- Recovery conservatively quarantines unknown `indexing` outcomes rather than duplicate upload. Reconcile by exact provider metadata; never search by approximate title or filename.

## Environment

The operator CLI imports the integrated `createKnowledgeRepository` from `services/api/dist/repositories/gemini-knowledge.js`; arbitrary repository modules are not permitted. `KNOWLEDGE_OPERATOR_TOKEN` must be checked by the operator's authorized repository boundary. `AGENT_KNOWLEDGE_ORIGINALS_ROOT` must be a private persistent path. `GEMINI_API_KEY` is from the isolated experiment. `GEMINI_FILE_SEARCH_MODEL` is a G1-tested Gemini model ID.

## Commands

Run from repository root:

```bash
node scripts/ingest-agent-knowledge.mjs validate ./approved/file.pdf
node scripts/ingest-agent-knowledge.mjs preview ./approved/file.md
node scripts/ingest-agent-knowledge.mjs create $AGENT_ID $VERSION_ID
node scripts/ingest-agent-knowledge.mjs submit $AGENT_ID $VERSION_ID $DOCUMENT_ID $REVISION_ID ./approved/file.pdf
# Separate human review creates an approval record through the authorized P2 administrative path.
node scripts/ingest-agent-knowledge.mjs approve $AGENT_ID $VERSION_ID $DOCUMENT_ID $REVISION_ID
node scripts/ingest-agent-knowledge.mjs index $AGENT_ID $VERSION_ID $DOCUMENT_ID $REVISION_ID
node scripts/verify-agent-knowledge.mjs $AGENT_ID $VERSION_ID ./approved/smokes.json
node scripts/ingest-agent-knowledge.mjs publish $AGENT_ID $VERSION_ID null
node scripts/ingest-agent-knowledge.mjs status $AGENT_ID $VERSION_ID
node scripts/ingest-agent-knowledge.mjs retire $AGENT_ID $OLD_VERSION_ID
node scripts/ingest-agent-knowledge.mjs revoke $AGENT_ID $VERSION_ID 'approved reason'
# Irreversible, manual retention-controlled cleanup, never implicit on publish/retire:
node scripts/ingest-agent-knowledge.mjs purge $AGENT_ID $OLD_VERSION_ID DELETE:$AGENT_ID:$OLD_VERSION_ID
```

Smoke format: `[ {"mode":"positive","question":"...","expectedDocumentVersionIds":["..."]}, {"mode":"negative","question":"..."} ]`. The Google adapter accepts an **exact** provider document resource, or an exact custom-metadata tuple verified against a unique ACTIVE provider document and independent PostgreSQL provenance. Titles and snippet similarity never establish identity. G1 must prove the exact API/model evidence format live; if metadata is absent, fail closed.

`--dry-run` on mutations prints only a high-level operation, performs **no** write or API call. `validate` and `preview` are always dry runs. ZIP batch submission requires `KNOWLEDGE_ENABLE_ARCHIVES=true` and produces one document/version identifier per extracted file; each member requires review. It may partially submit, so inspect status and resolve any earlier records before retrying. No credentials or approved originals should be committed.

## Integration gates

1. P2/P3 are integrated through the scoped PostgreSQL knowledge adapter, immutable provenance, secure originals, CAS publication and pinned-session checks; confirm these gates in the target deployment.
2. P1/G1 supplies compatible model and real provider evidence. Google response annotations may expose a URI/title rather than the exact `fileSearchStores/.../documents/...` ID: if this occurs, record a compatibility blocker. Never forge source mapping from a filename.
3. P4 consumes the returned structural `ApprovedDocumentEvidence`, validates real source excerpt and independently qualifies business claims. An approved citation **alone is not evidence of entailment**.
4. Runtime ownership/revocation checks are integrated; live operator credential, actual approved Sara sources and provider resource lifecycle still require independent verification. This module does not expose a public knowledge-management route.

Test with `node --experimental-strip-types --test services/api/src/knowledge/knowledge.test.mjs`. Mock tests are not live Google File Search verification.
