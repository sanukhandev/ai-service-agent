import { AIProjectClient } from "@azure/ai-projects";
import { AzureCliCredential } from "@azure/identity";
import {
  runNodeFunctionLoop,
  type FoundryTurnAdapter,
  type AgentFrame,
  type FunctionOutput,
} from "../agent/function-loop.js";
import { AgentToolRegistry } from "../agent/tool-registry.js";
import { FoundryError, classifyFoundryError } from "./errors.js";
import { aggregateTokenUsage, parseFoundryFrame } from "./response-adapter.js";
import type {
  FoundryClientOptions,
  FoundryTurnInput,
  FoundryTurnResult,
  TokenUsage,
} from "./types.js";

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(name + " is required for the published Foundry agent");
  return value.trim();
}

function positiveBounded(value: number | undefined, fallback: number, upper: number, name: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0 || actual > upper) {
    throw new RangeError(name + " must be an integer between 1 and " + upper);
  }
  return actual;
}

/**
 * The adapter does not create, reconfigure, deploy, or delete agents.
 * The published version must already contain IQ and compatible business-function definitions.
 *
 * The conversation owner must serialize turns per ticket and persist responseId atomically.
 */
export class FoundryClient {
  private readonly project: AIProjectClient;
  private readonly openai: ReturnType<AIProjectClient["getOpenAIClient"]>;
  private readonly timeoutMs: number;
  private readonly maxRounds: number;
  private readonly maxCalls: number;
  private readonly maxToolResultBytes: number;
  private readonly expectedName: string;
  private readonly expectedVersion: string;

  constructor(
    private readonly registry: AgentToolRegistry,
    options: FoundryClientOptions = {},
  ) {
    const endpoint = required(options.projectEndpoint ?? process.env.FOUNDRY_PROJECT_ENDPOINT, "FOUNDRY_PROJECT_ENDPOINT");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !url.pathname.includes("/api/projects/")) {
      throw new Error("FOUNDRY_PROJECT_ENDPOINT must be an HTTPS Foundry project endpoint");
    }
    this.expectedName = required(options.defaultAgentName ?? process.env.FOUNDRY_AGENT_NAME, "FOUNDRY_AGENT_NAME");
    this.expectedVersion = required(options.defaultAgentVersion ?? process.env.FOUNDRY_AGENT_VERSION, "FOUNDRY_AGENT_VERSION");
    this.timeoutMs = positiveBounded(options.timeoutMs, 60_000, 300_000, "timeoutMs");
    this.maxRounds = positiveBounded(options.maxRounds, 4, 12, "maxRounds");
    this.maxCalls = positiveBounded(options.maxCalls, 8, 32, "maxCalls");
    this.maxToolResultBytes = positiveBounded(options.maxToolResultBytes, 12_000, 100_000, "maxToolResultBytes");

    this.project = new AIProjectClient(endpoint.replace(/\/$/, ""), new AzureCliCredential());
    // Disable SDK automatic retries: a continuation might follow tool-backed durable writes.
    this.openai = this.project.getOpenAIClient({ maxRetries: 0 });
  }

  /** Diagnostic only. Requires project agent-version read permission. Never mutates Sara. */
  async verifyPublishedAgent(): Promise<{ name: string; version: string }> {
    try {
      const version = await this.project.agents.getVersion(this.expectedName, this.expectedVersion);
      if (version.name !== this.expectedName || version.version !== this.expectedVersion) {
        throw new FoundryError("FOUNDRY_AGENT_NOT_FOUND", "The expected published agent version was not returned", false);
      }
      return { name: version.name, version: version.version };
    } catch (error) {
      throw classifyFoundryError(error);
    }
  }

  async runTurn(input: FoundryTurnInput): Promise<FoundryTurnResult> {
    if (input.agentName !== this.expectedName || input.agentVersion !== this.expectedVersion) {
      throw new FoundryError("FOUNDRY_AGENT_NOT_FOUND", "The turn agent binding does not match the configured published version", false);
    }
    if (!input.message?.trim() || Buffer.byteLength(input.message, "utf8") > 65_536) {
      throw new FoundryError("FOUNDRY_API_FAILED", "Message must contain 1 to 65536 UTF-8 bytes", false);
    }
    if (!input.trustedToolContext?.agentId || !input.trustedToolContext.ticketId ||
        !input.trustedToolContext.principalId || !input.trustedToolContext.sourceCustomerMessageId) {
      throw new FoundryError("FOUNDRY_API_FAILED", "Missing trusted Node ticket or principal context", false);
    }

    const previousResponseId = input.conversationContext?.previousResponseId;
    if (previousResponseId !== undefined &&
        (typeof previousResponseId !== "string" || !/^resp_[A-Za-z0-9_-]+$/.test(previousResponseId))) {
      throw new FoundryError("FOUNDRY_API_FAILED", "Invalid previous Foundry response identifier", false);
    }

    const agent_reference = {
      name: this.expectedName,
      version: this.expectedVersion,
      type: "agent_reference" as const,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    const usages: TokenUsage[] = [];

    try {
      let parsed;
      try {
        const first = await this.openai.responses.create(
          {
            input: input.message,
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
            store: true,
          },
          {
            body: { agent_reference },
            timeout: this.timeoutMs,
            signal: controller.signal,
          },
        );
        parsed = parseFoundryFrame(first);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new FoundryError("FOUNDRY_TIMEOUT", "Foundry request timed out", true, undefined, error);
        }
        throw classifyFoundryError(error);
      }

      if (parsed.usage) usages.push(parsed.usage);
      let lastParsed = parsed;
      const adapter: FoundryTurnAdapter = {
        continueWithToolOutputs: async (frame: AgentFrame, results: readonly FunctionOutput[]) => {
          if (!frame.traceRef) {
            throw new FoundryError("FOUNDRY_INVALID_FUNCTION_CALL", "Foundry function response has no response ID", false);
          }
          if (controller.signal.aborted) {
            throw new FoundryError("FOUNDRY_TIMEOUT", "Foundry deadline exceeded before function continuation", true);
          }
          try {
            // A previous_response_id continues exactly the response containing these call IDs.
            const next = await this.openai.responses.create(
              {
                previous_response_id: frame.traceRef,
                input: results.map((result) => ({
                  type: "function_call_output" as const,
                  call_id: result.callId,
                  output: result.outputJson,
                })),
                store: true,
              },
              {
                body: { agent_reference },
                timeout: this.timeoutMs,
                signal: controller.signal,
              },
            );
            lastParsed = parseFoundryFrame(next);
            if (lastParsed.usage) usages.push(lastParsed.usage);
            return lastParsed.frame;
          } catch (error) {
            if (controller.signal.aborted) {
              throw new FoundryError("FOUNDRY_TIMEOUT", "Foundry function continuation timed out", true, undefined, error);
            }
            throw classifyFoundryError(error, "continuation");
          }
        },
      };

      let finalFrame: AgentFrame;
      try {
        finalFrame = await runNodeFunctionLoop(
          parsed.frame,
          adapter,
          this.registry,
          input.trustedToolContext,
          {
            maxRounds: this.maxRounds,
            maxCalls: this.maxCalls,
            maxToolResultBytes: this.maxToolResultBytes,
          },
        );
      } catch (error) {
        if (error instanceof FoundryError) throw error;
        if (controller.signal.aborted) {
          throw new FoundryError("FOUNDRY_TIMEOUT", "Foundry turn deadline exceeded", true, undefined, error);
        }
        if (error instanceof Error && /FOUNDRY_TOOL_BUDGET_EXCEEDED|FOUNDRY_TOOL_ROUND_LIMIT/.test(error.message)) {
          throw new FoundryError("FOUNDRY_TOOL_BUDGET_EXCEEDED", "Foundry function call budget exceeded", false, undefined, error);
        }
        if (error instanceof Error && error.message === "DUPLICATE_FOUNDRY_TOOL_CALL") {
          throw new FoundryError("FOUNDRY_INVALID_FUNCTION_CALL", "Duplicate Foundry function call ID", false, undefined, error);
        }
        throw classifyFoundryError(error, "continuation");
      }

      const text = finalFrame.outputs
        .filter((output): output is Extract<typeof output, { kind: "message" }> => output.kind === "message")
        .map((output) => output.text)
        .join("\n");
      if (!text.trim()) {
        throw new FoundryError("FOUNDRY_API_FAILED", "Foundry did not return a final assistant message", false);
      }
      return {
        status: "completed",
        text,
        sourceReferences: lastParsed.references,
        ...(finalFrame.traceRef ? { responseId: finalFrame.traceRef } : {}),
        ...(aggregateTokenUsage(usages) ? { usage: aggregateTokenUsage(usages) } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
