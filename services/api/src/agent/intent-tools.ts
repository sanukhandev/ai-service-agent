/**
 * Generic Node-owned catalog and ticket-fact functions.
 * No ANCFZ-specific logic or direct n8n dispatch.
 */
import { AgentToolRegistry, type ToolHandler } from "./tool-registry.js";

export interface IntentRequirement {
  readonly key: string;
  readonly label: string;
  readonly type: "text" | "number" | "email" | "choice";
  readonly requiredFor: ReadonlyArray<string>;
  readonly hint?: string;
}
export interface IntentEntry {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly examplePhrases: ReadonlyArray<string>;
  readonly requirements: ReadonlyArray<IntentRequirement>;
  readonly allowedActions: ReadonlyArray<string>;
}
export interface TicketFact {
  readonly key: string;
  readonly value: string | number | boolean;
  readonly sourceMessageId: string;
  readonly verification: "customer_stated" | "verified";
  readonly updatedAt: string;
}
export interface OfferingEntry {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly price?: {
    readonly currency: string;
    readonly amount: number;
    readonly revision: string;
    readonly conditions?: string;
  };
}
export interface CatalogRepository {
  listIntents(agentId: string, catalogVersion: string): Promise<IntentEntry[]>;
  listOfferings(agentId: string, catalogVersion: string, intentKey?: string): Promise<OfferingEntry[]>;
}
export interface TicketFactRepository {
  listFacts(agentId: string, ticketId: string): Promise<TicketFact[]>;
  /** Verify sourceMessageId is an actual customer message for this ticket, audit corrections. */
  recordCustomerFacts(
    agentId: string,
    ticketId: string,
    sourceMessageId: string,
    facts: ReadonlyArray<{ key: string; value: string | number | boolean }>,
  ): Promise<TicketFact[]>;
}
function requireText(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(field + " must be a bounded nonempty string");
  }
  return value.trim();
}
function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
/** Advisory candidate ordering only. Lexical mismatch must never reject an intent. */
function matchScore(query: string, intent: IntentEntry): number {
  const q = query.toLowerCase();
  const tokens = q.match(/[a-z0-9]{3,}/g) ?? [];
  const phrases = [...intent.examplePhrases, intent.name, intent.key.replaceAll("_", " ")];
  return phrases.reduce((best, phrase) => {
    const candidate = phrase.toLowerCase();
    const score = (q.includes(candidate) ? 10 : 0) +
      tokens.filter((token) => candidate.includes(token)).length;
    return Math.max(best, score);
  }, 0);
}
export function registerIntentTools(
  registry: AgentToolRegistry,
  catalog: CatalogRepository,
  facts: TicketFactRepository,
): void {
  const handlers: ToolHandler[] = [
    {
      name: "find_intents",
      description: "Discover supported business goals from this agent's published intent catalog. Call for actionable customer goals, not greetings or ordinary FAQ requests.",
      parameters: schema({
        query: { type: "string", maxLength: 500, description: "Customer's goal in plain language" },
      }, ["query"]),
      async execute(ctx, args) {
        const query = requireText(args["query"], "query");
        const all = await catalog.listIntents(ctx.agentId, ctx.intentCatalogRevision);
        const sorted = all
          .map((intent) => ({ intent, score: matchScore(query, intent) }))
          .sort((a, b) => b.score - a.score);
        // Catalog discovery is inclusive; avoid false rejections from keywords.
        const max = sorted.some((entry) => entry.score > 0) ? 8 : 12;
        return {
          catalogVersion: ctx.intentCatalogRevision,
          candidates: sorted.slice(0, max).map(({ intent }) => ({
            intentKey: intent.key,
            name: intent.name,
            description: intent.description,
            allowedActions: intent.allowedActions,
          })),
        };
      },
    },
    {
      name: "get_intent_requirements",
      description: "Retrieve the selected goal's requirements and current ticket facts. Ask the most useful missing question, not a complete questionnaire. Requirements may differ for each action.",
      parameters: schema({
        intentKey: { type: "string", maxLength: 128 },
        operationKey: { type: "string", maxLength: 128 },
      }, ["intentKey"]),
      async execute(ctx, args) {
        const intentKey = requireText(args["intentKey"], "intentKey", 128);
        const operationKey = typeof args["operationKey"] === "string"
          ? requireText(args["operationKey"], "operationKey", 128) : undefined;
        const intents = await catalog.listIntents(ctx.agentId, ctx.intentCatalogRevision);
        const intent = intents.find((candidate) => candidate.key === intentKey);
        if (!intent) return { error: "INTENT_NOT_FOUND" };
        const stored = await facts.listFacts(ctx.agentId, ctx.ticketId);
        const byKey = new Map(stored.map((fact) => [fact.key, fact]));
        return {
          catalogVersion: ctx.intentCatalogRevision,
          intentKey,
          allowedActions: intent.allowedActions,
          requirements: intent.requirements
            .filter((req) => !operationKey || req.requiredFor.includes(operationKey))
            .map((req) => ({
              key: req.key,
              label: req.label,
              type: req.type,
              hint: req.hint,
              requiredFor: req.requiredFor,
              value: byKey.get(req.key)?.value ?? null,
              verification: byKey.get(req.key)?.verification ?? "missing",
            })),
        };
      },
    },
    {
      name: "record_ticket_facts",
      description: "Persist details explicitly provided or corrected in the latest customer message. Never infer missing facts. Node records customer-stated provenance, not verified documents.",
      parameters: schema({
        intentKey: { type: "string", maxLength: 128 },
        facts: {
          type: "array",
          maxItems: 12,
          items: schema({
            key: { type: "string", maxLength: 128 },
            value: {
              oneOf: [
                { type: "string", maxLength: 1000 },
                { type: "number" },
                { type: "boolean" },
              ],
            },
          }, ["key", "value"]),
        },
      }, ["intentKey", "facts"]),
      async execute(ctx, args) {
        const intentKey = requireText(args["intentKey"], "intentKey", 128);
        const all = await catalog.listIntents(ctx.agentId, ctx.intentCatalogRevision);
        const intent = all.find((candidate) => candidate.key === intentKey);
        if (!intent) return { error: "INTENT_NOT_FOUND" };
        if (!Array.isArray(args["facts"]) || args["facts"].length > 12) {
          throw new Error("Invalid fact count");
        }
        const allowed = new Set(intent.requirements.map((req) => req.key));
        const updates = args["facts"].map((candidate) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new Error("Invalid customer fact");
          }
          const value = candidate as Record<string, unknown>;
          const key = requireText(value["key"], "key", 128);
          const factValue = value["value"];
          if (!allowed.has(key)) throw new Error("Unknown requirement key");
          if (
            (typeof factValue !== "string" && typeof factValue !== "number" &&
             typeof factValue !== "boolean") ||
            (typeof factValue === "string" && factValue.length > 1000) ||
            (typeof factValue === "number" && !Number.isFinite(factValue))
          ) throw new Error("Invalid fact");
          return { key, value: factValue };
        });
        const saved = await facts.recordCustomerFacts(
          ctx.agentId, ctx.ticketId, ctx.sourceCustomerMessageId, updates,
        );
        return {
          status: "recorded_as_customer_stated",
          intentKey,
          facts: saved.map((item) => ({
            key: item.key, value: item.value, verification: item.verification,
          })),
        };
      },
    },
    {
      name: "get_offerings",
      description: "Get the agent's published services/packages and authoritative price revisions for comparison. Formal quotes must use catalog prices and conditions, not model-generated RAG prices.",
      parameters: schema({
        intentKey: { type: "string", maxLength: 128 },
      }),
      async execute(ctx, args) {
        const intentKey = typeof args["intentKey"] === "string"
          ? requireText(args["intentKey"], "intentKey", 128) : undefined;
        return {
          catalogVersion: ctx.offeringCatalogRevision,
          offerings: await catalog.listOfferings(ctx.agentId, ctx.offeringCatalogRevision, intentKey),
        };
      },
    },
  ];
  for (const handler of handlers) registry.register(handler);
}
