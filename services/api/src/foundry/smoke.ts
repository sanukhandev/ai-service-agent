/**
 * Explicit, read-only smoke run against the published Sara agent.
 *
 * Usage:
 *   node dist/foundry/smoke.js
 *
 * The empty registry is deliberate: this script cannot perform app operations.
 * Do not use its synthetic context in authenticated HTTP routes.
 */
import { AgentToolRegistry, type TrustedToolContext } from "../agent/tool-registry.js";
import { FoundryClient } from "./client.js";
import { FoundryError } from "./errors.js";

const name = process.env.FOUNDRY_AGENT_NAME;
const version = process.env.FOUNDRY_AGENT_VERSION;
if (!name || !version) {
  throw new Error("FOUNDRY_AGENT_NAME and FOUNDRY_AGENT_VERSION are required");
}

const registry = new AgentToolRegistry();
const foundry = new FoundryClient(registry);
const smokeContext: TrustedToolContext = {
  agentId: "smoke-only-agent",
  ticketId: "smoke-only-ticket",
  principalId: "smoke-only-principal",
  sourceCustomerMessageId: "smoke-only-message",
  intentCatalogRevision: "smoke-only",
  offeringCatalogRevision: "smoke-only",
  authorizedToolNames: new Set(),
};

try {
  const published = await foundry.verifyPublishedAgent();
  console.log("Published agent version:", published.name, published.version);
  const prompts = [
    ["greeting", "Hello Sara. Please introduce yourself in one sentence."],
    ["knowledge", process.env.FOUNDRY_SMOKE_KNOWLEDGE_QUESTION ??
      "According to ANCFZ's approved knowledge, what documents are needed to start a company?"],
  ] as const;

  for (const [label, message] of prompts) {
    const result = await foundry.runTurn({
      agentName: name,
      agentVersion: version,
      message,
      trustedToolContext: smokeContext,
      conversationContext: {},
    });
    console.log(JSON.stringify({
      label,
      status: result.status,
      text: result.text,
      responseId: result.responseId,
      sourceReferences: result.sourceReferences,
      usage: result.usage,
    }, null, 2));
    if (label === "knowledge" && result.sourceReferences.length === 0) {
      process.exitCode = 2;
      console.error("Knowledge smoke did not return verifiable source annotations");
    }
  }
} catch (error) {
  process.exitCode = 1;
  if (error instanceof FoundryError) {
    console.error(error.code, error.message, error.statusCode ?? "");
  } else {
    console.error("Foundry smoke failed:", error);
  }
}
