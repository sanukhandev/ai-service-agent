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
  readonly verification: "customer_stated" | "verified" | "disputed";
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
export interface TicketIntentRepository {
  selectIntent(
    agentId: string,
    ticketId: string,
    catalogVersion: string,
    intentKey: string,
  ): Promise<{ intentKey: string; status: string }>;
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
  ticketIntents: TicketIntentRepository,
): void {
  const handlers: ToolHandler[] = [
    {
      name: "select_ticket_intent",
      description: "Save the supported customer goal currently being discussed. The selected intent is durable ticket context, not authorization to perform any business workflow.",
      parameters: schema({
        intentKey: { type: "string", maxLength: 128 },
      }, ["intentKey"]),
      async execute(ctx, args) {
        const intentKey = requireText(args["intentKey"], "intentKey", 128);
        const intents = await catalog.listIntents(ctx.agentId, ctx.intentCatalogRevision);
        if (!intents.some((intent) => intent.key === intentKey)) {
          return { error: "INTENT_NOT_FOUND" };
        }
        return await ticketIntents.selectIntent(
          ctx.agentId, ctx.ticketId, ctx.intentCatalogRevision, intentKey,
        );
      },
    },
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
        if (operationKey && !intent.allowedActions.includes(operationKey)) {
          return { error: "OPERATION_NOT_ALLOWED_FOR_INTENT" };
        }
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
      description: "Query published offerings. Use visaCount (0–10) and termYears (1–5) for exact ANCFZ 2026 test package prices; optional offeringKey for direct lookup. Requests without filters return a concise overview, not the entire catalog. Source-derived test prices are not binding quotations.",
      parameters: schema({
        intentKey: { type: "string", maxLength: 128 },
        offeringKey: { type: "string", maxLength: 128 },
        visaCount: { type: "integer", minimum: 0, maximum: 10 },
        termYears: { type: "integer", minimum: 1, maximum: 5 },
        limit: { type: "integer", minimum: 1, maximum: 15 },
      }),
      async execute(ctx, args) {
        const intentKey = typeof args["intentKey"] === "string"
          ? requireText(args["intentKey"], "intentKey", 128) : undefined;
        const offeringKey = typeof args["offeringKey"] === "string"
          ? requireText(args["offeringKey"], "offeringKey", 128) : undefined;
        function integer(name: "visaCount" | "termYears" | "limit", min: number, max: number): number | undefined {
          const value = args[name];
          if (value === undefined) return undefined;
          if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            throw new Error("Invalid " + name);
          }
          return value;
        }
        const visaCount = integer("visaCount", 0, 10);
        const termYears = integer("termYears", 1, 5);
        const limit = integer("limit", 1, 15) ?? 8;
        // Package comparisons and quotations must be able to see the
        // company-formation price SKUs, not just generic package summaries.
        const packageIntents = new Set(["company_formation", "package_comparison", "quotation_request"]);
        const broadPackageQuery = intentKey !== undefined && packageIntents.has(intentKey);
        // Preserve the P3 baseline service results as well as the expanded
        // ANCFZ package-price records. The repository's intent filter remains
        // authoritative; do not hardcode a list of existing offering keys.
        const fetched = await catalog.listOfferings(
          ctx.agentId, ctx.offeringCatalogRevision,
          offeringKey ? undefined : intentKey,
        );
        if (broadPackageQuery) {
          for (const relatedIntent of ["company_formation", "package_comparison"]) {
            if (relatedIntent !== intentKey) {
              const related = await catalog.listOfferings(
                ctx.agentId, ctx.offeringCatalogRevision, relatedIntent,
              );
              const existing = new Set(fetched.map((item) => item.key));
              for (const item of related) if (!existing.has(item.key)) fetched.push(item);
            }
          }
        }
        const selected = fetched.filter((offer) => {
          if (offeringKey && offer.key !== offeringKey) return false;
          const match = /^visa_(\d+)_y([1-5])$/.exec(offer.key);
          if (visaCount !== undefined && (!match || Number(match[1]) !== visaCount)) return false;
          if (termYears !== undefined && (!match || Number(match[2]) !== termYears)) return false;
          return true;
        });
        // Unfiltered requests get a useful overview, with direct SKU lookup
        // recommended for exact prices. Do not overflow the function budget.
        const overviewPriority = [
          "pay_as_you_go", "zero_visa_package", "visa_all_inclusive",
          "executive_office_package", "retail_package",
          "visa_0_y1", "visa_1_y1", "visa_2_y1", "visa_3_y1",
        ];
        if (visaCount === undefined && termYears === undefined && !offeringKey) {
          selected.sort((a, b) => {
            const rank = (key: string) => {
              const index = overviewPriority.indexOf(key);
              return index < 0 ? 100 : index;
            };
            return rank(a.key) - rank(b.key) || a.key.localeCompare(b.key);
          });
        }
        return {
          catalogVersion: ctx.offeringCatalogRevision,
          totalMatches: selected.length,
          returned: Math.min(selected.length, limit),
          hasMore: selected.length > limit,
          ...(selected.length > limit
            ? { guidance: "Specify visaCount, termYears or offeringKey to retrieve the exact published test variant." }
            : {}),
          offerings: selected.slice(0, limit),
        };
      },
    },
  ];
  for (const handler of handlers) registry.register(handler);
}
