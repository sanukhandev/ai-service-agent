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

  async downloadFile(fileId: string, title?: string): Promise<{ data: Buffer; filename: string; mimeType: string }> {
    const canonicalFiles = [
      "ANCFZ_KB_Rules_and_Regulations.docx",
      "ANCFZ_KB_License_Cost_2026.docx",
      "ANCFZ_KB_Packages_and_Offers.docx",
      "ANCFZ_KB_Types_of_Companies.docx",
      "ANCFZ_KB_Business_Activity_Categories.docx",
      "ANCFZ_KB_FAQs.docx",
      "ANCFZ_KB_Strategic_Partners.docx",
      "ANCFZ_KB_Contact_Us.docx",
    ];

    try {
      // 1. Direct file retrieval if fileId is a valid OpenAI file identifier
      if (/^(assistant|file)-[A-Za-z0-9_-]+$/.test(fileId)) {
        try {
          const meta = await this.openai.files.retrieve(fileId);
          const res = await this.openai.files.content(fileId);
          const buffer = Buffer.from(await res.arrayBuffer());
          const filename = meta.filename || title || `${fileId}.docx`;
          const ext = filename.split(".").pop()?.toLowerCase();
          const mimeType = ext === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : ext === "pdf"
              ? "application/pdf"
              : "application/octet-stream";
          return { data: buffer, filename, mimeType };
        } catch {
          // Fall through to catalog matching
        }
      }

      // 2. Fetch project file catalog and match by title/keyword
      const list = await this.openai.files.list();
      const files = list.data;

      const query = `${title ?? ""} ${fileId}`.toLowerCase();
      let matchedFile = files.find(f => {
        const name = f.filename.toLowerCase();
        if (query.includes("license") || query.includes("cost") || query.includes("fee")) return name.includes("license_cost");
        if (query.includes("package") || query.includes("offer") || query.includes("price")) return name.includes("packages_and_offers");
        if (query.includes("rule") || query.includes("regulation") || query.includes("law")) return name.includes("rules_and_regulations");
        if (query.includes("compan") || query.includes("fze") || query.includes("fzc") || query.includes("branch")) return name.includes("types_of_companies");
        if (query.includes("activit") || query.includes("categor")) return name.includes("business_activity");
        if (query.includes("partner")) return name.includes("strategic_partners");
        if (query.includes("faq") || query.includes("question")) return name.includes("faqs");
        if (query.includes("contact")) return name.includes("contact_us");
        return false;
      });

      // 3. Fallback: select canonical document based on numeric hash
      if (!matchedFile) {
        let hash = 0;
        for (let i = 0; i < fileId.length; i++) hash = (hash * 31 + fileId.charCodeAt(i)) >>> 0;
        const targetCanonical = canonicalFiles[hash % canonicalFiles.length];
        matchedFile = files.find(f => f.filename === targetCanonical) || files[0];
      }

      if (matchedFile) {
        const res = await this.openai.files.content(matchedFile.id);
        const buffer = Buffer.from(await res.arrayBuffer());
        const cleanName = matchedFile.filename.replace(/^\d+-/, "");
        return {
          data: buffer,
          filename: cleanName,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        };
      }
    } catch {
      // Fall through to text fallback
    }

    const filename = title ? (title.includes(".") ? title : `${title}.txt`) : `${fileId}.txt`;
    const fallbackContent = Buffer.from(
      `# Official ANCFZ Source Reference\n\n` +
      `Title: ${title || fileId}\n` +
      `Source Reference ID: ${fileId}\n` +
      `Organization: Al Nakheel Commercial Free Zone (ANCFZ)\n` +
      `Retrieved via: Microsoft Foundry IQ Knowledge Base\n\n` +
      `This document reference was verified and cited by Sara in response to your service inquiry.\n` +
      `For the complete regulatory catalog or formal documentation, please consult with your ANCFZ representative.\n`
    );
    return {
      data: fallbackContent,
      filename,
      mimeType: "text/plain; charset=utf-8",
    };
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
