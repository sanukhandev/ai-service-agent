export type FoundryErrorCode =
  | "FOUNDRY_AUTHENTICATION_FAILED"
  | "FOUNDRY_AGENT_NOT_FOUND"
  | "FOUNDRY_IQ_TOOL_FAILED"
  | "FOUNDRY_RATE_LIMIT"
  | "FOUNDRY_TIMEOUT"
  | "FOUNDRY_INVALID_FUNCTION_CALL"
  | "FOUNDRY_FUNCTION_CONTINUATION_FAILED"
  | "FOUNDRY_TOOL_BUDGET_EXCEEDED"
  | "FOUNDRY_SUBSCRIPTION_DISABLED"
  | "FOUNDRY_API_FAILED";

export class FoundryError extends Error {
  override readonly name = "FoundryError";

  constructor(
    readonly code: FoundryErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/** Safely categorize SDK and Azure Identity exceptions without exposing upstream response bodies. */
export function classifyFoundryError(error: unknown, phase: "invoke" | "continuation" = "invoke"): FoundryError {
  if (error instanceof FoundryError) return error;
  const info = record(error);
  const status = typeof info?.status === "number" ? info.status
    : typeof info?.statusCode === "number" ? info.statusCode : undefined;
  const name = typeof info?.name === "string" ? info.name : "";
  const code = typeof info?.code === "string" ? info.code : "";
  const errorMsg = typeof (error as Error)?.message === "string" ? (error as Error).message : "";
  if (
    code === "SubscriptionNotRegistered" ||
    code === "ReadOnlyDisabledSubscription" ||
    /subscription.*disabled|spending.*limit|not registered with the Microsoft\.CognitiveServices/i.test(errorMsg)
  ) {
    return new FoundryError("FOUNDRY_SUBSCRIPTION_DISABLED", "Azure subscription is disabled or spending limit reached", false, status, error);
  }
  if (status === 401 || status === 403 || /credential|authentication|authorization/i.test(name)) {
    return new FoundryError("FOUNDRY_AUTHENTICATION_FAILED", "Azure Foundry authentication or authorization failed", false, status, error);
  }
  if (status === 404) {
    return new FoundryError("FOUNDRY_AGENT_NOT_FOUND", "The published Foundry agent or requested version was not found", false, status, error);
  }
  if (status === 429) {
    return new FoundryError("FOUNDRY_RATE_LIMIT", "Foundry rate limit exceeded", true, status, error);
  }
  if (status === 408 || status === 504 || /timeout|timedout|abort/i.test(name + " " + code)) {
    return new FoundryError("FOUNDRY_TIMEOUT", "Foundry request timed out", true, status, error);
  }
  if (phase === "continuation") {
    return new FoundryError("FOUNDRY_FUNCTION_CONTINUATION_FAILED", "Foundry function output continuation failed", false, status, error);
  }
  return new FoundryError("FOUNDRY_API_FAILED", "Foundry request failed", false, status, error);
}
