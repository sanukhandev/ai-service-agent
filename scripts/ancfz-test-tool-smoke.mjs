// Lightweight deterministic tool-call smoke using the real Node registry.
// Does not contact Foundry or execute business actions.
import fs from "node:fs";
import assert from "node:assert/strict";
import { AgentToolRegistry } from "../services/api/dist/agent/tool-registry.js";
import { registerIntentTools } from "../services/api/dist/agent/intent-tools.js";
import { classifyAction, SUPPORTED_CATALOG_ACTIONS } from "../services/api/dist/runtime/intent-action-operations.js";

const seed = JSON.parse(fs.readFileSync(new URL("../infra/catalog/ancfz-test-2026.json", import.meta.url), "utf8"));
const registry = new AgentToolRegistry();
const catalog = {
  async listIntents() {
    return seed.intents.map((i) => ({
      key: i.key, name: i.name, description: i.description,
      examplePhrases: i.examplePhrases, requirements: i.requirements,
      allowedActions: i.allowedActions,
    }));
  },
  async listOfferings(_agent, _revision, intentKey) {
    return seed.offerings
      .filter((o) => intentKey === undefined || o.intentKey === intentKey)
      .map((o) => ({
        key: o.key, label: o.label, description: o.description,
        ...(o.price ? { price: {
          currency: o.price.currency, amount: o.price.amount,
          revision: "1", conditions: o.price.conditions,
        } } : {}),
      }));
  },
};
registerIntentTools(registry, catalog, {
  async listFacts() { return []; },
  async recordCustomerFacts() { throw Error("not in smoke scope"); },
}, { async selectIntent() { throw Error("not in smoke scope"); } });

const ctx = {
  agentId: "test-agent", ticketId: "test-ticket",
  principalId: "test-principal", sourceCustomerMessageId: "test-message",
  intentCatalogRevision: String(seed.intentRevision),
  offeringCatalogRevision: String(seed.offeringRevision),
  authorizedToolNames: new Set(["get_offerings"]),
};
async function invoke(args) {
  const result = await registry.execute({
    callId: "smoke", name: "get_offerings", argumentsJson: JSON.stringify(args),
  }, ctx);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
const one = await invoke({ intentKey: "quotation_request", visaCount: 1, termYears: 1 });
assert.equal(one.returned, 1);
assert.equal(one.offerings[0].key, "visa_1_y1");
assert.equal(one.offerings[0].price.amount, 10800);

const fiveYears = await invoke({ offeringKey: "visa_10_y5" });
assert.equal(fiveYears.returned, 1);
assert.equal(fiveYears.offerings[0].price.amount, 200880);

const overview = await invoke({ intentKey: "package_comparison" });
assert.ok(overview.hasMore);
assert.equal(overview.returned, 8);
assert.ok(overview.offerings.some((o) => o.key === "visa_all_inclusive"));
assert.ok(overview.offerings.some((o) => o.key === "pay_as_you_go"));
const invalid = await registry.execute({
  callId: "invalid", name: "get_offerings",
  argumentsJson: '{"visaCount":11}',
}, ctx);
assert.equal(invalid.ok, false);
console.log("get_offerings tool PASS: exact price, package overview, bounds");

const allActions = new Set(seed.intents.flatMap(i=>i.allowedActions));
const external=["create_lead","generate_quote","purchase_quotation"];
for(const entry of seed.intents){
  const actions=new Set(entry.allowedActions);
  if(actions.has("generate_quote")){
    actions.add("create_lead");
    actions.add("purchase_quotation");
  }
  for(const action of actions){
    assert.ok(SUPPORTED_CATALOG_ACTIONS.has(action),
      "Catalog action has no Node handler: "+entry.key+" / "+action);
    assert.notEqual(classifyAction(action),null);
  }
}
assert.ok(allActions.has("create_amendment_request"));
assert.ok(allActions.has("request_specialist_review"));
assert.ok(allActions.has("create_support_request"));
assert.equal(new Set([...allActions].filter(a=>!external.includes(a))).size,7);
console.log("21-intent action matrix PASS: every declared operation mapped to a customer-owned Node executor");
