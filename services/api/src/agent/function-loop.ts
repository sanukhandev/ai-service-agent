/**
 * Node-only tool loop for client-executed Foundry functions.
 * P1 must adapt current @azure/ai-projects Responses SDK payloads.
 * Native Foundry IQ retrieval is a Foundry-managed tool, not handled here.
 */
import {
  AgentToolRegistry,
  type ModelToolCall,
  type TrustedToolContext,
} from "./tool-registry.js";

export type AgentOutput =
  | { readonly kind: "message"; readonly text: string; readonly citations?: unknown[] }
  | { readonly kind: "function_call"; readonly call: ModelToolCall };

export interface AgentFrame {
  readonly outputs: readonly AgentOutput[];
  readonly traceRef?: string;
}

export interface FunctionOutput {
  readonly callId: string;
  readonly outputJson: string;
}

export interface FoundryTurnAdapter {
  /** Continue the SAME Foundry conversation with function_call_output items. */
  continueWithToolOutputs(
    frame: AgentFrame,
    outputs: readonly FunctionOutput[],
  ): Promise<AgentFrame>;
}

export interface LoopLimits {
  readonly maxRounds?: number;
  readonly maxCalls?: number;
  readonly maxToolResultBytes?: number;
}

export async function runNodeFunctionLoop(
  firstFrame: AgentFrame,
  adapter: FoundryTurnAdapter,
  registry: AgentToolRegistry,
  context: TrustedToolContext,
  limits: LoopLimits = {},
): Promise<AgentFrame> {
  const maxRounds = limits.maxRounds ?? 4;
  const maxCalls = limits.maxCalls ?? 8;
  const maxToolResultBytes = limits.maxToolResultBytes ?? 12000;

  if (maxRounds < 1 || maxCalls < 1) throw new Error("Invalid tool budget");

  let frame = firstFrame;
  let totalCalls = 0;
  const seen = new Set<string>();

  for (let round = 0; round < maxRounds; round++) {
    const calls = frame.outputs
      .filter((output): output is Extract<AgentOutput, { kind: "function_call" }> =>
        output.kind === "function_call")
      .map((output) => output.call);

    if (calls.length === 0) return frame;
    if (totalCalls + calls.length > maxCalls) {
      throw new Error("FOUNDRY_TOOL_BUDGET_EXCEEDED");
    }
    totalCalls += calls.length;
    const results: FunctionOutput[] = [];

    for (const call of calls) {
      if (seen.has(call.callId)) throw new Error("DUPLICATE_FOUNDRY_TOOL_CALL");
      seen.add(call.callId);
      const result = await registry.execute(call, context);
      let outputJson = JSON.stringify(result);
      if (Buffer.byteLength(outputJson, "utf8") > maxToolResultBytes) {
        outputJson = JSON.stringify({
          ok: false,
          error: { code: "TOOL_RESULT_TOO_LARGE", message: "Result exceeds limit" },
        });
      }
      results.push({ callId: call.callId, outputJson });
    }

    frame = await adapter.continueWithToolOutputs(frame, results);
  }

  if (frame.outputs.some((output) => output.kind === "function_call")) {
    throw new Error("FOUNDRY_TOOL_ROUND_LIMIT");
  }
  return frame;
}
