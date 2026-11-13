import type { TrustedToolContext } from "../agent/tool-registry.js";

/** Previous response ID is loaded from the *authorized ticket*, never from model output. */
export interface FoundryConversationContext {
  readonly previousResponseId?: string;
}

export interface FoundryTurnInput {
  readonly agentName: string;
  readonly agentVersion: string;
  readonly message: string;
  readonly conversationContext: FoundryConversationContext;
  readonly trustedToolContext: TrustedToolContext;
}

/** Only actual provider-returned annotation fields are exposed; nothing is inferred. */
export interface SourceReference {
  readonly type: string;
  readonly fileId?: string;
  readonly filename?: string;
  readonly title?: string;
  readonly url?: string;
  readonly startIndex?: number;
  readonly endIndex?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
}

export interface FoundryTurnResult {
  readonly status: "completed" | "failed";
  readonly text: string;
  readonly sourceReferences: readonly SourceReference[];
  readonly responseId?: string;
  readonly usage?: TokenUsage;
}

export interface FoundryClientOptions {
  readonly projectEndpoint?: string;
  readonly defaultAgentName?: string;
  readonly defaultAgentVersion?: string;
  /** End-to-end model request budget. Individual tool handlers need their own deadlines. */
  readonly timeoutMs?: number;
  readonly maxRounds?: number;
  readonly maxCalls?: number;
  readonly maxToolResultBytes?: number;
}
