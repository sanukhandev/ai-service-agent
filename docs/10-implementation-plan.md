# Gemini experiment — delivery and remaining certification

The **single authoritative implementation plan** is [Gemini experiment implementation plan](gemini-experiment-implementation-plan.md). This page summarizes the integrated experiment and does not define a separate delivery track.

## Integrated implementation milestones

| Phase | Implemented component | Evidence boundary |
| --- | --- | --- |
| G0 | Frozen Gemini contracts and isolation rules | Static CI checks |
| P1 | Gemini model adapter and bounded function continuation | Offline adapter tests; live G1 still required |
| P2 | PostgreSQL tickets, scoped 60-minute AI sessions, migrations and persistence | Disposable DB integration |
| P3 | Approved File Search source intake, provider adapter and document provenance | Offline normalization and source mapping tests |
| P4 | Independent response grounding verifier | Deterministic policy tests |
| P5 | Approved Node-to-n8n adapter | Mock/sandbox adapter tests; real provider UAT still required |
| P6 | Golden, security, session, workflow certification harness | Offline harness; real local/live adapter pending |
| P7 | One Gemini turn worker, Next.js sessions, Compose and integration | Exact-head API/web/Docker/DB gates |

Implementation integrated is not the same as provider-verified or production-certified.

## Remaining acceptance work

1. **G1 live Gemini:** Confirm the actual model/API supports the required File Search document identity, metadata, approved citations, function calls and continuation using a synthetic temporary store.
2. **Approved Sara knowledge:** Publish operator-approved documents, test actual retrieval and independently supported/unsupported claims, revocation and controlled downloads. Unapproved catalog pricing remains insufficient for formal quotes.
3. **Sandbox n8n journey:** Verify permissioned lead, quote and applicable payment flows with real provider references and retry/idempotency safeguards.
4. **P6 live/local certification:** Complete quality, source isolation, expiry/restart/replay, false-rejection, performance and cost gates against an isolated exact-SHA deployment.
5. **Final audit:** Confirm no obsolete provider entrypoint or cloud credentials, verify agent authorization and migration checksums, and rerun the full exact-head CI.

No PR to `main`; no cross-project credential or volume sharing. See [P7 status](gemini-p7-status.md) for executable opt-in live smoke and detailed blockers.
