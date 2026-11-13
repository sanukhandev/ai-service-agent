import type { AgentFrame, AgentOutput } from "../agent/function-loop.js";
import type { SourceReference, TokenUsage } from "./types.js";
import { FoundryError } from "./errors.js";

type Obj = Record<string, unknown>;

function object(value: unknown): Obj | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Obj : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sourceFromAnnotation(value: unknown): SourceReference | undefined {
  const a = object(value);
  const type = string(a?.type);
  if (!a || !type || (!type.endsWith("_citation") && type !== "url_citation")) return undefined;
  return {
    type,
    ...(string(a.file_id) ? { fileId: string(a.file_id) } : {}),
    ...(string(a.filename) ? { filename: string(a.filename) } : {}),
    ...(string(a.title) ? { title: string(a.title) } : {}),
    ...(string(a.url) ? { url: string(a.url) } : {}),
    ...(number(a.start_index) !== undefined ? { startIndex: number(a.start_index) } : {}),
    ...(number(a.end_index) !== undefined ? { endIndex: number(a.end_index) } : {}),
  };
}

export interface ParsedFoundryFrame {
  readonly frame: AgentFrame;
  readonly references: readonly SourceReference[];
  readonly usage?: TokenUsage;
}

export function parseFoundryFrame(response: unknown): ParsedFoundryFrame {
  const r = object(response);
  if (!r) throw new FoundryError("FOUNDRY_API_FAILED", "Invalid Foundry response structure", false);

  const status = string(r.status);
  if (status === "failed" || status === "incomplete" || status === "cancelled") {
    throw new FoundryError("FOUNDRY_API_FAILED", "Foundry returned a non-completed response", false);
  }
  if (status === "queued" || status === "in_progress") {
    // Non-streaming client has no completion poll in this adapter.
    throw new FoundryError("FOUNDRY_API_FAILED", "Foundry response is not yet complete", false);
  }

  const outputs: AgentOutput[] = [];
  const references: SourceReference[] = [];
  const seenReferences = new Set<string>();
  const items = Array.isArray(r.output) ? r.output : [];
  for (const rawItem of items) {
    const item = object(rawItem);
    const type = string(item?.type);
    if (!item || !type) continue;

    if ((type === "mcp_call" || type === "file_search_call") &&
        (item.error != null || item.status === "failed")) {
      throw new FoundryError("FOUNDRY_IQ_TOOL_FAILED", "Foundry knowledge tool failed", false);
    }
    if (type === "function_call") {
      const callId = string(item.call_id);
      const name = string(item.name);
      const argumentsJson = string(item.arguments);
      if (!callId || !name || argumentsJson === undefined) {
        throw new FoundryError("FOUNDRY_INVALID_FUNCTION_CALL", "Foundry emitted an invalid function call", false);
      }
      outputs.push({ kind: "function_call", call: { callId, name, argumentsJson } });
      continue;
    }
    if (type !== "message" || item.role !== "assistant") continue;

    const textParts: string[] = [];
    const content = Array.isArray(item.content) ? item.content : [];
    for (const rawPart of content) {
      const part = object(rawPart);
      if (!part) continue;
      if (part.type === "output_text" && typeof part.text === "string") textParts.push(part.text);
      const annotations = Array.isArray(part.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        const reference = sourceFromAnnotation(annotation);
        if (!reference) continue;
        const key = JSON.stringify(reference);
        if (!seenReferences.has(key)) {
          references.push(reference);
          seenReferences.add(key);
        }
      }
    }
    if (textParts.length) outputs.push({ kind: "message", text: textParts.join(""), citations: references });
  }
  if (!outputs.some((output) => output.kind === "message") && typeof r.output_text === "string" && r.output_text) {
    outputs.push({ kind: "message", text: r.output_text });
  }

  const usageRaw = object(r.usage);
  const inputTokens = number(usageRaw?.input_tokens);
  const outputTokens = number(usageRaw?.output_tokens);
  const totalTokens = number(usageRaw?.total_tokens);
  const cached = number(object(usageRaw?.input_tokens_details)?.cached_tokens);
  const usage: TokenUsage | undefined = inputTokens !== undefined &&
    outputTokens !== undefined && totalTokens !== undefined
    ? { inputTokens, outputTokens, totalTokens, ...(cached !== undefined ? { cachedInputTokens: cached } : {}) }
    : undefined;

  return {
    frame: {
      outputs,
      ...(string(r.id) ? { traceRef: string(r.id) } : {}),
    },
    references,
    ...(usage ? { usage } : {}),
  };
}

export function aggregateTokenUsage(usages: readonly TokenUsage[]): TokenUsage | undefined {
  if (usages.length === 0) return undefined;
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    ...(usages.some((usage) => usage.cachedInputTokens !== undefined) ? {
      cachedInputTokens: usages.reduce((sum, usage) => sum + (usage.cachedInputTokens ?? 0), 0),
    } : {}),
  };
}
