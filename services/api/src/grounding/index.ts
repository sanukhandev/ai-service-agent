import { createHash } from "node:crypto";
import type { AgentRuntimeBinding, AiSessionState, ApprovedDocumentEvidence, AuthorizedActionOutcome, GroundingDecision, MaterialClaimDecision, ModelTurnCandidate, ResponseCategory, VerifiedClaimEvidence } from "@ai-service-agent/contracts/gemini-v1";

/** P4 is read-only. The caller must load all records from authenticated Node repositories. */
export const VERIFIER_VERSION = "gemini-grounding-p4.1" as const;
export type SourceRecord = Omit<ApprovedDocumentEvidence, "approvalStatus" | "indexStatus"> & {
  readonly approvalStatus: "approved" | "draft" | "retired" | "revoked";
  readonly indexStatus: "active" | "pending" | "failed" | "removed";
  /** Independently extracted and retained original text, NEVER the provider-supplied annotation excerpt. */
  readonly verifiedText: string | null;
  readonly verifiedTextSha256: string | null;
};
export interface CatalogRecord {
  readonly agentId: string;
  readonly catalogVersionId: string;
  readonly recordId: string;
  readonly approved: boolean;
  readonly approvalReference: string | null;
  readonly sourceDocumentVersionId: string | null;
  readonly sourceSha256: string | null;
  readonly statement: string;
  /** Optional authoritative fields; checked against candidate independently of prose entailment. */
  readonly exactFacts?: Readonly<Record<string, string | number>>;
}
export interface OperationRecord {
  readonly outcome: AuthorizedActionOutcome;
  readonly statement: string;
  /** Must be true only after independently verified final business-provider evidence, not HTTP 202. */
  readonly completionVerified: boolean;
}
export interface TicketFact {
  readonly key: string;
  readonly value: string | number;
  readonly verified: boolean;
}
export interface SemanticCheck {
  readonly claim: string;
  readonly evidenceText: string;
  readonly source: "document" | "catalog" | "operation";
}
export type SemanticVerifier = (input: SemanticCheck, signal: AbortSignal) => Promise<"entailed" | "contradicted" | "unknown">;
export interface GroundingInput {
  readonly candidate: Pick<ModelTurnCandidate, "text" | "sourceAnnotations">;
  readonly agent: AgentRuntimeBinding;
  /** Session is required to prevent knowledge/catalog version drift during the active turn. */
  readonly session: AiSessionState;
  readonly documents: readonly SourceRecord[];
  readonly catalogs: readonly CatalogRecord[];
  readonly operations: readonly OperationRecord[];
  readonly customerFacts?: readonly TicketFact[];
  /** Defaults to 750ms; limits the optional semantic verification budget. */
  readonly budgetMs?: number;
  /** Optional independent, read-only evidence-constrained verification; no retries or tools. */
  readonly semanticVerifier?: SemanticVerifier;
}

const BAD_INSTRUCTIONS = /\b(?:ignore (?:all |the |any )?(?:previous|system|developer) instructions|disable (?:the )?verif(?:ier|ication)|search (?:the )?web|reveal (?:private |customer )?(?:data|secrets)|execute (?:a )?payment|switch (?:the )?knowledge stor(?:e|es)|call (?:a )?webhook)\b/i;
const SOCIAL = /^(?:(?:hi|hello|hey|good morning|good afternoon|good evening|goodbye|bye|thanks|thank you|ok|okay|you're welcome|welcome|sure|certainly|glad to help|how can i help you|i can help with that)[\s.!?,]*)+$/i;
const SOFT_GREETING = /^(?:(?:hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you)[,!\s]+)+/i;
const QUESTION = /^(?:what|which|where|when|who|how|could|would|can|may|please|tell|do|does|did|is|are|shall|should)\b/i;
const FACTUAL_QUESTION = /\b(?:cost|price|aed|usd|visa|license|licence|eligible|required|included|completed|approved|issued|succeeded|successful|\d)\b/i;
const NEGATION = /\b(?:not|no|never|cannot|can't|won't|without|excluded|prohibited)\b/i;
const SCOPE_WORDS = ["only", "at least", "at most", "up to", "more than", "less than", "must", "required", "optional", "eligible", "free", "guaranteed", "guarantee", "will", "can", "may", "might", "should", "shall", "always", "never", "every", "all", "any", "none", "usually", "typically", "generally"];
const WORD_EQUIVALENTS: Readonly<Record<string, string>> = Object.freeze({
  registration: "register", registering: "register", registered: "register", register: "register",
  setup: "register", establish: "register", establishing: "register", formation: "register",
  company: "company", business: "company", digitally: "online", digital: "online", online: "online",
  completed: "complete", completing: "complete", completion: "complete", finish: "complete",
  prices: "cost", priced: "cost", pricing: "cost", price: "cost", costs: "cost", cost: "cost",
  licence: "license", licensing: "license", licenses: "license", license: "license",
  visas: "visa", visa: "visa", permits: "visa", permit: "visa",
  includes: "include", included: "include", including: "include", include: "include",
  requires: "require", required: "require", requirement: "require", require: "require",
  issued: "issue", issuance: "issue", issue: "issue",
  generated: "generate", generating: "generate", generate: "generate",
  succeeded: "success", successful: "success", successfully: "success", success: "success",
  aed: "aed", dhs: "aed", dirhams: "aed", dirham: "aed",
  dollars: "usd", dollar: "usd", usd: "usd",
  days: "day", day: "day", weeks: "week", week: "week",
  available: "available", availability: "available",
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
});
const STOP = new Set("a an the to for by in on with of from and or but your you my our their its it this that these those is are was were be being been as at via per we us i they he she there here please also just very get obtaining offer offers may can could would will able service services".split(" "));

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const shaOK = (sha: string | null): boolean => typeof sha === "string" && /^[a-f\d]{64}$/i.test(sha);
const pieces = (text: string): string[] => text.replace(/(\d)\.(\d)/g, "$1\uE000$2")
  .split(/[.!?;\n]+|\s+\b(?:and|but)\b\s+/i).map(s => s.replace(/\uE000/g, ".").trim()).filter(Boolean);
const normalized = (text: string): string => text.toLowerCase().replace(/\bset[ -]?up\b/g, "setup")
  .replace(/\bcompany formation\b/g, "company registration").replace(/\bon\s*line\b/g, "online")
  .replace(/\bquotations?\b/g, "quotes").replace(/\bquotes?\b/g, "quotation")
  .replace(/\bnot eligible\b/g, "ineligible");
const tokens = (text: string): string[] => (normalized(text).match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
  .map(x => WORD_EQUIVALENTS[x] ?? x).filter(x => !STOP.has(x));
const numbers = (s: string): string[] => [...normalized(s).matchAll(/(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?(?![\p{L}\p{N}])/gu)]
  .map(m => String(Number(m[0].replace(/,/g, "")))).sort();
const currency = (s: string): string[] => tokens(s).filter(x => x === "aed" || x === "usd" || x === "eur" || x === "gbp").sort();
const signaturesEqual = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);
function exactInvariant(claim: string, text: string): boolean {
  if (!signaturesEqual(numbers(claim), numbers(text))) return false;
  if (!signaturesEqual(currency(claim), currency(text))) return false;
  if (NEGATION.test(claim) !== NEGATION.test(text)) return false;
  const c = normalized(claim), e = normalized(text);
  for (const q of SCOPE_WORDS) {
    if ((new RegExp(`\\b${q}\\b`).test(c)) !== (new RegExp(`\\b${q}\\b`).test(e))) return false;
  }
  return true;
}
/** Conservative lexical-semantic entailment: ALL material tokens, not an overlap percentage. */
function deterministicEntailment(claim: string, text: string): boolean {
  if (!exactInvariant(claim, text)) return false;
  const source = new Set(tokens(text));
  return tokens(claim).every(token => source.has(token));
}
function claimCategory(text: string): ResponseCategory {
  if (SOCIAL.test(text)) return "social";
  if (/\b(?:queued|dispatched|sent|submitted|created|completed|generated|succeeded|failed|approved|processed|charged|billed|booked|paid|emailed)\b/i.test(text) && /\b(?:lead|quote|quotation|payment|invoice|application|request|operation|workflow|bill|charge|booking|email)\b/i.test(text)) return "operation_status";
  if (/\b(?:aed|usd|eur|gbp|price|cost|package|visa|license|licence|fee|term|duration)\b|\d/i.test(text)) return "catalog_factual";
  if (text.endsWith("?") && QUESTION.test(text) && !FACTUAL_QUESTION.test(text)) return "clarification";
  if (text.endsWith("?") && /^(?:please|could|would|what|which|how|tell)\b/i.test(text) && !/\b(?:is|are|will|does|costs|includes)\b/i.test(text)) return "clarification";
  return "business_factual";
}
function classify(text: string): { category: ResponseCategory; claims: string[] } {
  if (SOCIAL.test(text.trim())) return { category: "social", claims: [] };
  const clauses = pieces(text.replace(SOFT_GREETING, ""));
  if (clauses.length === 0) return { category: "social", claims: [] };
  const classified = clauses.map((x, index) => ({ text: x, category: claimCategory(text.trimEnd().endsWith("?") && index === clauses.length - 1 ? `${x}?` : x) }));
  const claims = classified.filter(x => x.category !== "social" && x.category !== "clarification").map(x => x.text);
  if (!claims.length && classified.every(x => x.category === "clarification" || x.category === "social")) {
    return { category: classified.some(x => x.category === "clarification") ? "clarification" : "social", claims: [] };
  }
  const categories = classified.filter(x => x.category !== "social" && x.category !== "clarification").map(x => x.category);
  return { category: categories.includes("operation_status") ? "operation_status" : categories.includes("catalog_factual") ? "catalog_factual" : "business_factual", claims };
}
function evidence(id: string, claimId: string, agentId: string, authority: VerifiedClaimEvidence["authority"], documentVersionId: string | null, knowledgeVersionId: string | null): VerifiedClaimEvidence {
  return { authority, agentId, claimId, evidenceId: id, documentVersionId, knowledgeVersionId };
}
function failure(status: GroundingDecision["status"], category: ResponseCategory, code: string, claims: readonly MaterialClaimDecision[] = []): GroundingDecision {
  return { status, category, verifierVersion: VERIFIER_VERSION, reasonCode: code, claims };
}
function usableDoc(doc: SourceRecord, agent: AgentRuntimeBinding, session: AiSessionState): string | null {
  if (!agent.knowledge || doc.agentId !== agent.agentId || session.agentId !== agent.agentId ||
    doc.knowledgeVersionId !== agent.knowledge.knowledgeVersionId || doc.knowledgeVersionId !== session.knowledgeVersionId ||
    doc.providerStoreResourceName !== agent.knowledge.storeResourceName ||
    agent.knowledge.state !== "published" || !agent.knowledge.approvalReference || !agent.knowledge.publishedAt ||
    doc.approvalStatus !== "approved" || doc.indexStatus !== "active" || !doc.approvalReference || !shaOK(doc.sourceSha256)) return "DOCUMENT_NOT_AUTHORIZED";
  if (!doc.verifiedText || !doc.verifiedTextSha256 || sha256(doc.verifiedText) !== doc.verifiedTextSha256) return "SOURCE_TEXT_UNAVAILABLE";
  return null;
}
function usableCatalog(record: CatalogRecord, input: GroundingInput): boolean {
  const expected = record.catalogVersionId === input.session.offeringCatalogVersionId || record.catalogVersionId === input.session.intentCatalogVersionId;
  const facts = Object.values(record.exactFacts ?? {});
  const available = new Set(tokens(record.statement));
  const matchingFacts = facts.every(value => {
    const valueTokens = tokens(String(value));
    const valueNumbers = numbers(String(value));
    return valueTokens.every(x => available.has(x)) || (valueNumbers.length > 0 && valueNumbers.every(x => numbers(record.statement).includes(x)));
  });
  return record.agentId === input.agent.agentId && expected && record.approved && matchingFacts &&
    !!record.approvalReference && !!record.sourceDocumentVersionId && shaOK(record.sourceSha256) && !!record.statement.trim();
}
function usableOperation(record: OperationRecord, input: GroundingInput): boolean {
  const result = record.outcome;
  return result.agentId === input.agent.agentId && result.ticketId === input.session.ticketId &&
    result.state === "verified" && record.completionVerified && !!result.verifiedAt &&
    !!result.providerReference && !!result.providerCorrelationReference && !!result.consentReference && !!result.idempotencyKey;
}
function relevantFactMismatch(claim: string, facts: readonly TicketFact[]): boolean {
  // Customer facts are a *contradiction guard only*: never evidence for business rules.
  return facts.some(f => f.verified && new RegExp(`\\b${f.key.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`, "i").test(claim) &&
    !tokens(claim).includes(String(f.value).toLowerCase()) && !numbers(claim).includes(String(f.value)));
}

/** Never calls external tools, persists data, rewrites responses or dispatches actions. */
export async function verifyGrounding(input: GroundingInput): Promise<GroundingDecision> {
  const { candidate, agent, session } = input;
  const { category, claims } = classify(candidate.text || "");
  if (!candidate.text?.trim()) return failure("insufficient_evidence", "business_factual", "EMPTY_CANDIDATE");
  if (BAD_INSTRUCTIONS.test(candidate.text)) return failure("unsupported", category, "UNSAFE_CANDIDATE_INSTRUCTION");
  if (candidate.text.length > 12_000 || (candidate.sourceAnnotations?.length ?? 0) > 16 ||
    input.documents.length > 64 || input.catalogs.length > 128 || input.operations.length > 64 ||
    input.documents.some(d => (d.verifiedText?.length ?? 0) > 200_000)) {
    return failure("verifier_unavailable", category, "VERIFIER_INPUT_LIMIT_EXCEEDED");
  }
  if (session.status !== "active" || !(Date.parse(session.expiresAt) > Date.now()))
    return failure("unauthorized_source", category, "SESSION_EXPIRED");
  if (session.agentId !== agent.agentId || session.agentVersionId !== agent.agentVersionId ||
    (session.knowledgeVersionId !== (agent.knowledge?.knowledgeVersionId ?? null))) return failure("unauthorized_source", category, "SESSION_BINDING_MISMATCH");
  if (session.offeringCatalogVersionId !== agent.offeringCatalogVersionId || session.intentCatalogVersionId !== agent.intentCatalogVersionId) return failure("unauthorized_source", category, "SESSION_CATALOG_MISMATCH");
  const budgetMs = input.budgetMs ?? 750;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return failure("verifier_unavailable", category, "VERIFIER_BUDGET_EXHAUSTED");
  if (claims.length === 0) return { status: "supported", category, verifierVersion: VERIFIER_VERSION, reasonCode: null, claims: [] };

  const annotations = candidate.sourceAnnotations ?? [];
  const authorizedDocs: SourceRecord[] = [];
  for (const citation of annotations) {
    if (!citation.providerResourceName) return failure("unauthorized_source", category, "UNMAPPED_CITATION");
    const matching = input.documents.filter(doc => doc.providerDocumentResourceName === citation.providerResourceName);
    if (matching.length !== 1) return failure("unauthorized_source", category, "UNKNOWN_OR_AMBIGUOUS_CITATION");
    const doc = matching[0];
    const issue = usableDoc(doc, agent, session);
    if (issue === "SOURCE_TEXT_UNAVAILABLE") return failure("insufficient_evidence", category, issue);
    if (issue) return failure("unauthorized_source", category, issue);
    if (!authorizedDocs.some(d => d.documentVersionId === doc.documentVersionId)) authorizedDocs.push(doc);
  }
  const catalogs = input.catalogs.filter(c => usableCatalog(c, input));
  const operations = input.operations.filter(o => usableOperation(o, input));
  const started = Date.now();
  const decisions: MaterialClaimDecision[] = [];
  let unavailable = false;
  for (let i = 0; i < claims.length; i++) {
    const claimText = claims[i], claimId = `claim-${i+1}`;
    const sources: { text: string; e: VerifiedClaimEvidence; kind: SemanticCheck["source"] }[] = [];
    for (const doc of authorizedDocs) for (const sentence of pieces(doc.verifiedText!)) {
      if (!BAD_INSTRUCTIONS.test(sentence)) sources.push({ text: sentence, kind: "document", e: evidence(doc.documentVersionId, claimId, agent.agentId, "approved_file_search", doc.documentVersionId, doc.knowledgeVersionId) });
    }
    for (const record of catalogs) for (const sentence of pieces(record.statement)) {
      if (!BAD_INSTRUCTIONS.test(sentence)) sources.push({ text: sentence, kind: "catalog", e: evidence(record.recordId, claimId, agent.agentId, "approved_catalog", record.sourceDocumentVersionId, null) });
    }
    for (const record of operations) for (const sentence of pieces(record.statement)) {
      if (!BAD_INSTRUCTIONS.test(sentence)) sources.push({ text: sentence, kind: "operation", e: evidence(record.outcome.outboxId, claimId, agent.agentId, "verified_operation", null, null) });
    }
    // Operation success claims MUST have independently verified operation evidence, never just a document.
    const candidates = category === "operation_status" ? sources.filter(s => s.kind === "operation") : sources.filter(s => s.kind !== "operation");
    let match = candidates.find(s => deterministicEntailment(claimText, s.text));
    if (!match && input.semanticVerifier) {
      for (const source of candidates.filter(s => exactInvariant(claimText, s.text))) {
        const remaining = budgetMs - (Date.now() - started);
        if (remaining <= 0) { unavailable = true; break; }
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            input.semanticVerifier({ claim: claimText, evidenceText: source.text, source: source.kind }, controller.signal),
            new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), remaining); }),
          ]);
          if (result === "timeout") { unavailable = true; controller.abort(); break; }
          if (result === "entailed") { match = source; break; }
        } catch { unavailable = true; break; }
        finally { if (timer) clearTimeout(timer); controller.abort(); }
      }
    }
    if (relevantFactMismatch(claimText, input.customerFacts ?? [])) match = undefined;
    decisions.push({ claimId, claimText, supported: !!match, reason: match ? null : unavailable ? "VERIFIER_UNAVAILABLE" : candidates.length ? "CLAIM_NOT_ENTAILED" : "NO_APPROVED_EVIDENCE", evidence: match ? [match.e] : [] });
    if (unavailable) break;
  }
  if (unavailable) return failure("verifier_unavailable", category, "SEMANTIC_CHECK_UNAVAILABLE", decisions);
  if (decisions.every(x => x.supported)) return { status: "supported", category, verifierVersion: VERIFIER_VERSION, reasonCode: null, claims: decisions };
  return failure(decisions.some(x => x.reason === "CLAIM_NOT_ENTAILED") ? "unsupported" : "insufficient_evidence", category,
    decisions.some(x => x.reason === "CLAIM_NOT_ENTAILED") ? "UNSUPPORTED_CLAIM" : "NO_APPROVED_EVIDENCE", decisions);
}
/** The integration owner must only persist/publish the original candidate if this is true. */
export const canPublishCandidate = (decision: GroundingDecision): boolean => decision.status === "supported";
