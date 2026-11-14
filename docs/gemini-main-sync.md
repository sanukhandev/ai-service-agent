# Main → Gemini experiment integration record

**Upstream source:** `main@997555539e11cbe2be15406f69c07306aef6baae` (four ANCFZ billing/journey commits since common ancestor `82aa16de387ebbe78b7741092d799cb6f1420379`).  
**Target:** `experiment/gemini-file-search-poc` only. The `main` branch is never changed by this integration.

## Imported business changes

- 21-intent ANCFZ source-derived catalog action mapping; optional intent-specific requirements and operator-controlled publication, without mutating the immutable Gemini persona/model version.
- ANCFZ invoice/2Checkout mock n8n workflow definitions, guarded upgrade tooling, private credential templates, billing runbooks and offline contract tests.
- Server-authorized intent action APIs and a single customer action panel; Node controls workflow eligibility, consent, idempotency and provider outcomes. Gemini cannot call n8n directly.
- Customer-owned synthetic purchase documents, OTP challenge, sandbox payment/invoice state machines and independent payment verification workers. Dispatch defaults to **disabled**.
- Agent-scoped SQL migrations ported **without overwriting any existing 009–015 Gemini migration**:

| Original main migration | Gemini experiment migration |
| --- | --- |
| `009_2checkout_test_payments.sql` | `016_2checkout_test_payments.sql` |
| `010_intent_purchase_documents.sql` | `017_intent_purchase_documents.sql` |
| `011_payment_auto_verification.sql` | `018_payment_auto_verification.sql` |
| `012_identity_extraction.sql` | `019_identity_extraction.sql` |
| `013_intent_service_requests.sql` | `020_intent_service_requests.sql` |

The migration runner applies 003–020 using immutable checksums, then the published Sara Gemini seed and a versioned ANCFZ purchase-policy seed. It does not rewrite previously applied Gemini SQL or change the agent's published model configuration.

## Explicit conflict resolutions

- **Model runtime:** retain `GeminiTurnWorker`, Gemini File Search, independent Node grounding and the 60-minute AI session contract. Do not import main's `turn-worker.ts` or Foundry SDK.
- **Knowledge:** File Search source approval and published identity remain separate from customer-uploaded passport/Emirates ID documents. A document upload does not authorize general RAG knowledge.
- **Runtime tools:** only registered intent/requirements/facts/offerings tools are model-visible. Purchase readiness passed to Gemini is redacted: no billing name, document IDs, filenames, OTP, quote amount, or raw OCR values.
- **UI:** replace duplicate lead/quote forms with `IntentActionPanel`, retaining Gemini session handling and ticket-owned download checks.
- **Business actions:** Node HTTP routes perform authoritative authorization. 2Checkout test dispatch, OTP and mock email are disabled without explicit configuration; no external provider completion is inferred from HTTP status alone.
- **OCR:** main's Azure Document Intelligence integration is optional and disabled unless separately configured. With Azure on hold, identity extraction is **blocked**, not replaced with unverified model inference. Synthetic OCR is used only by isolated disposable tests.
- **CI:** retire main-only Foundry CI, keep Gemini G0/P7 tests, add ANCFZ static workflow/credential/catalog/payment gates and disposable PostgreSQL migration and action checks.

## Acceptance remaining

Even with all offline CI green, full certification still requires an authorized Gemini G1 live File Search test, approved Sara document store/source evidence, real isolated 2Checkout mock/n8n provider UAT, independent identity-OCR approval and full P6 local/live security/grounding checks. Do not issue real invoices or collect real identity documents using a localhost HTTP sandbox.

Source files were reviewed and adapted for the Gemini model boundary rather than blindly overwriting conflicting runtime code. Any subsequent upstream changes require a fresh compare and targeted conflict review.
