/**
 * Node-owned Foundry function registry. Foundry sees descriptions, but only
 * Node executes the application functions with server-derived ticket scope.
 * No n8n/CRM callback or execution entry point is registered as a model tool.
 */
export type ReadToolName =
  | "find_intents" | "get_intent_requirements" | "get_offerings"
  | "get_ticket_context" | "get_document_data" | "get_operation_status";
export type ContextToolName = "record_ticket_facts";
export type ProposalToolName = "preflight_operation" | "propose_operation";
export type RegisteredToolName = ReadToolName | ContextToolName | ProposalToolName;

export interface TrustedToolContext {
  readonly agentId: string;
  readonly ticketId: string;
  readonly principalId: string;
  readonly sourceCustomerMessageId: string;
  readonly catalogVersion: string;
  readonly authorizedToolNames: ReadonlySet<RegisteredToolName>;
}

export interface ToolHandler {
  readonly name: RegisteredToolName;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly maxArgumentBytes?: number;
  execute(
    context: TrustedToolContext,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export type ToolResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

const FORBIDDEN_SCOPE_KEYS = new Set([
  "agentId", "agent_id", "ticketId", "ticket_id",
  "principalId", "accountId", "workflowUrl", "n8nUrl", "providerCredentials",
]);

function parseArgs(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export class AgentToolRegistry {
  private readonly handlers = new Map<RegisteredToolName, ToolHandler>();

  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.name)) throw new Error("Duplicate tool: " + handler.name);
    this.handlers.set(handler.name, handler);
  }

  /** Only advertise implemented and agent-authorized function definitions. */
  definitions(context: TrustedToolContext): Array<{
    type: "function";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: false;
  }> {
    return [...this.handlers.values()]
      .filter((tool) => context.authorizedToolNames.has(tool.name))
      .map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false as const,
      }));
  }

  async execute(call: ModelToolCall, context: TrustedToolContext): Promise<ToolResult> {
    const handler = this.handlers.get(call.name as RegisteredToolName);
    if (!handler || !context.authorizedToolNames.has(handler.name)) {
      return { ok: false, error: { code: "TOOL_NOT_AUTHORIZED", message: "Tool unavailable" } };
    }
    if (Buffer.byteLength(call.argumentsJson, "utf8") > (handler.maxArgumentBytes ?? 8192)) {
      return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "Arguments too large" } };
    }
    let args: Record<string, unknown>;
    try {
      args = parseArgs(call.argumentsJson);
      for (const key of Object.keys(args)) {
        if (FORBIDDEN_SCOPE_KEYS.has(key)) {
          throw new Error("The model cannot provide a trusted scope");
        }
      }
    } catch {
      return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "Invalid tool arguments" } };
    }
    try {
      const data = await handler.execute(context, args);
      return { ok: true, data };
    } catch {
      // Log a correlated/redacted exception in the caller, not the model output.
      return { ok: false, error: { code: "TOOL_FAILED", message: "Tool could not complete" } };
    }
  }
}
