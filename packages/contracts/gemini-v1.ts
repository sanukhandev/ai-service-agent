/**
 * Gemini contract v1 — integration-owned and experiment-only.
 * This is a contract/policy definition, not a working model or ingestion client.
 * All IDs below are trusted server/persistence inputs, never direct model authority.
 */
export const GEMINI_CONTRACT_VERSION = "gemini-contract-v1" as const;
export const AI_SESSION_IDLE_SECONDS = 3600 as const;
export const GEMINI_ALLOWED_BUILTIN_TOOLS = ["file_search"] as const;
export const GEMINI_FORBIDDEN_TOOLS = [
  "google_search", "url_context", "google_maps", "code_execution",
  "browser", "web_fetch", "external_url_fetch",
] as const;
export type GeminiBuiltinToolName = typeof GEMINI_ALLOWED_BUILTIN_TOOLS[number];
export type AgentId = string; // Validated server-issued UUID
export type Uuid = string;
export type IsoTimestamp = string;

export type NodeBusinessToolName =
  | "find_intents" | "get_intent_requirements" | "get_offerings"
  | "get_ticket_context" | "get_document_data" | "get_operation_status"
  | "record_ticket_facts" | "select_ticket_intent"
  | "preflight_operation" | "propose_operation";

export type KnowledgeVersionState =
  | "draft" | "indexing" | "verified" | "published" | "retired" | "revoked";

export interface KnowledgeStoreBinding {
  readonly agentId: AgentId;
  readonly knowledgeVersionId: Uuid;
  readonly provider: "gemini_file_search";
  /** Exact server-authorized Google resource; not supplied by customer/model. */
  readonly storeResourceName: string;
  readonly state: KnowledgeVersionState;
  readonly contentDigestSha256: string;
  readonly approvalReference: string | null;
  readonly publishedAt: IsoTimestamp | null;
}

export interface AgentRuntimeBinding {
  readonly agentId: AgentId;
  readonly agentVersionId: Uuid;
  readonly provider: "gemini";
  readonly modelId: string;
  readonly personaVersion: string;
  readonly systemInstructions: string;
  readonly authorizedToolNames: readonly NodeBusinessToolName[];
  /** Null means social/clarification only, not an ungrounded factual answer. */
  readonly knowledge: KnowledgeStoreBinding | null;
  readonly intentCatalogVersionId: Uuid | null;
  readonly offeringCatalogVersionId: Uuid | null;
}

export interface ApprovedDocumentEvidence {
  readonly agentId: AgentId;
  readonly knowledgeVersionId: Uuid;
  readonly documentId: Uuid;
  readonly documentVersionId: Uuid;
  readonly providerStoreResourceName: string;
  readonly providerDocumentResourceName: string;
  readonly sourceSha256: string;
  readonly sourceTitle: string;
  readonly sourceLocator: string | null;
  readonly evidenceExcerpt: string | null;
  readonly approvalReference: string;
  readonly approvalStatus: "approved";
  readonly indexStatus: "active";
}

export interface ProviderContinuation {
  readonly provider: "gemini";
  readonly modelId: string;
  readonly opaqueRef: string | null;
  /** Storage pointer for required pending-function state/signatures, if any. */
  readonly pendingToolStateRef: string | null;
}

export interface AiSessionState {
  readonly sessionId: Uuid;
  readonly agentId: AgentId;
  readonly ticketId: Uuid;
  readonly agentVersionId: Uuid;
  readonly knowledgeVersionId: Uuid | null;
  readonly intentCatalogVersionId: Uuid | null;
  readonly offeringCatalogVersionId: Uuid | null;
  readonly status: "active" | "expired" | "closed";
  readonly createdAt: IsoTimestamp;
  readonly lastAcceptedCustomerMessageAt: IsoTimestamp;
  /** Only accepted customer messages extend this database-owned deadline. */
  readonly expiresAt: IsoTimestamp;
  readonly providerContinuation: ProviderContinuation | null;
}

export interface ModelConversationMessage {
  readonly role: "customer" | "assistant" | "tool";
  readonly text: string;
  readonly sourceMessageId: Uuid | null;
}

export interface ModelTurnRequest {
  readonly requestId: Uuid;
  readonly acceptedCustomerMessageId: Uuid;
  readonly agent: AgentRuntimeBinding;
  readonly session: AiSessionState;
  readonly currentSessionHistory: readonly ModelConversationMessage[];
  readonly customerMessage: string;
  readonly allowedBuiltinTools: readonly GeminiBuiltinToolName[];
  readonly allowedBusinessToolNames: readonly NodeBusinessToolName[];
  readonly deadlineMs: number;
}

export interface ModelFunctionCall {
  readonly callId: string;
  readonly name: NodeBusinessToolName;
  readonly argumentsJson: string;
}

export interface ProviderSourceAnnotation {
  readonly providerResourceName: string | null;
  readonly sourceTitle: string | null;
  readonly sourceUri: string | null;
  readonly excerpt: string | null;
  readonly locator: string | null;
  /**
   * File Search citation custom metadata, as emitted by Google.
   * Untrusted until matched against the session-pinned PostgreSQL approval
   * registry. Never use these fields directly as authorization.
   */
  readonly sourceMetadata?: Readonly<Record<string, string>>;
}

export interface ModelTurnCandidate {
  readonly provider: "gemini";
  readonly modelId: string;
  readonly text: string;
  readonly sourceAnnotations: readonly ProviderSourceAnnotation[];
  readonly functionCalls: readonly ModelFunctionCall[];
  readonly continuation: ProviderContinuation | null;
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
  readonly finishReason: string | null;
}

export type ModelProviderErrorCode =
  | "MODEL_UNAVAILABLE" | "FILE_SEARCH_UNAVAILABLE" | "MODEL_TIMEOUT"
  | "TOOL_NOT_AUTHORIZED" | "TOOL_CONTINUATION_INVALID"
  | "MODEL_OUTPUT_INVALID";
export type ModelTurnResult =
  | { readonly kind: "candidate"; readonly candidate: ModelTurnCandidate }
  | { readonly kind: "failure"; readonly code: ModelProviderErrorCode; readonly retryable: boolean };

export type ResponseCategory =
  | "social" | "clarification" | "business_factual"
  | "catalog_factual" | "operation_status";
export type EvidenceAuthority =
  | "approved_file_search" | "approved_catalog" | "verified_operation";

export interface VerifiedClaimEvidence {
  readonly authority: EvidenceAuthority;
  readonly agentId: AgentId;
  readonly claimId: string;
  readonly evidenceId: string;
  readonly documentVersionId: Uuid | null;
  readonly knowledgeVersionId: Uuid | null;
}
export interface MaterialClaimDecision {
  readonly claimId: string;
  readonly claimText: string;
  readonly supported: boolean;
  readonly reason: string | null;
  readonly evidence: readonly VerifiedClaimEvidence[];
}
export type GroundingStatus =
  | "supported" | "unsupported" | "insufficient_evidence"
  | "unauthorized_source" | "verifier_unavailable";
export interface GroundingDecision {
  readonly status: GroundingStatus;
  readonly category: ResponseCategory;
  readonly verifierVersion: string;
  readonly claims: readonly MaterialClaimDecision[];
  readonly reasonCode: string | null;
}

export interface AuthorizedActionOutcome {
  readonly agentId: AgentId;
  readonly ticketId: Uuid;
  readonly operationKey: string;
  readonly idempotencyKey: string;
  readonly consentReference: string;
  readonly outboxId: Uuid;
  readonly providerCorrelationReference: string | null;
  readonly state: "verified" | "uncertain" | "failed";
  readonly providerReference: string | null;
  readonly verifiedAt: IsoTimestamp | null;
}

export type GeminiKnowledgePolicy = Readonly<{
  mode: "approved_documents_and_catalog_only";
  allowedBuiltinTools: readonly GeminiBuiltinToolName[];
  externalWebSearch: false;
  externalUrlContext: false;
  usePretrainedBusinessFactsAsEvidence: false;
  requireEvidenceForBusinessClaims: true;
  failClosedOnMissingEvidence: true;
  customerVisibleCitations: false;
}>;

/** Runtime components must enforce these constants, not merely send a prompt. */
export const STRICT_GEMINI_KNOWLEDGE_POLICY: GeminiKnowledgePolicy = Object.freeze({
  mode: "approved_documents_and_catalog_only",
  allowedBuiltinTools: GEMINI_ALLOWED_BUILTIN_TOOLS,
  externalWebSearch: false,
  externalUrlContext: false,
  usePretrainedBusinessFactsAsEvidence: false,
  requireEvidenceForBusinessClaims: true,
  failClosedOnMissingEvidence: true,
  customerVisibleCitations: false,
});

/** Minimal defensive tool guard. P4 adds independent semantic verification. */
export function assertAllowedGeminiBuiltinTool(name: string): asserts name is GeminiBuiltinToolName {
  if (name !== "file_search") {
    throw new Error("GEMINI_TOOL_FORBIDDEN: only approved File Search is allowed");
  }
}
