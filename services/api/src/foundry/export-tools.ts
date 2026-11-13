/** Export five P3 Node function definitions for a controlled Foundry publication. */
import { AgentToolRegistry, type RegisteredToolName, type TrustedToolContext } from "../agent/tool-registry.js";
import { registerIntentTools } from "../agent/intent-tools.js";

const registry=new AgentToolRegistry();
const unavailable=async():Promise<never>=>{throw new Error("Schema export only");};
registerIntentTools(registry,{
  listIntents:unavailable,listOfferings:unavailable,
},{
  listFacts:unavailable,recordCustomerFacts:unavailable,
},{
  selectIntent:unavailable,
});
const names:RegisteredToolName[]=[
  "find_intents","select_ticket_intent","get_intent_requirements",
  "record_ticket_facts","get_offerings",
];
const scope:TrustedToolContext={
  agentId:"00000000-0000-4000-8000-000000000001",
  ticketId:"00000000-0000-4000-8000-000000000002",
  principalId:"export",sourceCustomerMessageId:"00000000-0000-4000-8000-000000000003",
  intentCatalogRevision:"1",offeringCatalogRevision:"1",
  authorizedToolNames:new Set(names),
};
process.stdout.write(JSON.stringify({
  schemaVersion:"p3-node-functions-1",publishedAgentVersionRequired:true,
  preserveExistingFoundryIq:true,functionTools:registry.definitions(scope),
},null,2)+"\n");
