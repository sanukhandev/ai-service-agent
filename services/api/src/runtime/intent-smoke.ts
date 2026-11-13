/**
 * Disposable P3 integration smoke, never used by HTTP routes or model runtime.
 * Runs against the restricted agent_runtime login in GitHub Actions.
 * Requires two distinct persisted customer messages created through the API.
 */
import assert from "node:assert/strict";
import { PersistenceDatabase } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { ConversationContextRepository } from "../repositories/context.js";
import { scopedIntentToolRepositories } from "../repositories/intent-adapter.js";
import { workerTicketScope } from "../repositories/types.js";
import { AgentToolRegistry, type RegisteredToolName, type TrustedToolContext } from "../agent/tool-registry.js";
import { registerIntentTools } from "../agent/intent-tools.js";

async function main() {
  if (process.env.P3_OFFLINE_SMOKE !== "1") throw new Error("CI-only smoke must be explicitly enabled");
  const ticketId=process.env.P3_TEST_TICKET;
  const firstMessageId=process.env.P3_TEST_MESSAGE1;
  const correctionMessageId=process.env.P3_TEST_MESSAGE2;
  if(!ticketId||!firstMessageId||!correctionMessageId) throw new Error("Missing smoke records");
  const db=new PersistenceDatabase(process.env.DATABASE_URL);
  try {
    await db.assertSafeRuntimeRole();
    const agents=new AgentRepository(db);
    const identity=await agents.resolvePublicKey("ancfz");
    assert.ok(identity);
    const scope=workerTicketScope(identity.id,ticketId);
    const pinned=await agents.getPinnedForTicket(scope,ticketId);
    assert.ok(pinned.intentCatalogRevision);
    assert.ok(pinned.offeringCatalogRevision);
    const adapters=scopedIntentToolRepositories(db,scope,ticketId);
    const registry=new AgentToolRegistry();
    registerIntentTools(registry,adapters.catalog,adapters.facts,adapters.ticketIntents);
    const allowed:ReadonlySet<RegisteredToolName>=new Set([
      "find_intents","select_ticket_intent","get_intent_requirements","record_ticket_facts","get_offerings",
    ]);
    const context:TrustedToolContext={
      agentId:identity.id,ticketId,principalId:"ci-p3-internal-scope",
      sourceCustomerMessageId:firstMessageId,
      intentCatalogRevision:pinned.intentCatalogRevision,
      offeringCatalogRevision:pinned.offeringCatalogRevision,
      authorizedToolNames:allowed,
    };
    let call=0;
    async function invoke(name:RegisteredToolName,args:Record<string,unknown>,override?:TrustedToolContext) {
      const result=await registry.execute({
        name,callId:"p3-smoke-"+(++call),argumentsJson:JSON.stringify(args),
      },override??context);
      assert.equal(result.ok,true,`tool ${name}: ${JSON.stringify(result)}`);
      if(!result.ok) throw new Error("Unreachable tool error");
      return result.data as Record<string,unknown>;
    }
    const matches=await invoke("find_intents",{query:"I want to start a software company"});
    assert.ok((matches.candidates as Array<{intentKey:string}>).some(x=>x.intentKey==="company_formation"));
    const selected=await invoke("select_ticket_intent",{intentKey:"company_formation"});
    assert.equal(selected.status,"active");
    await invoke("record_ticket_facts",{
      intentKey:"company_formation",
      facts:[
        {key:"business_activity",value:"IT services"},
        {key:"visa_count",value:1},
        {key:"office_preference",value:"shared office"},
      ],
    });
    const requirements=await invoke("get_intent_requirements",{intentKey:"company_formation"});
    const items=requirements.requirements as Array<{key:string;value:unknown}>;
    assert.equal(items.find(x=>x.key==="visa_count")?.value,1);
    assert.ok(items.some(x=>x.key==="shareholder_count"&&x.value===null));
    const offers=await invoke("get_offerings",{intentKey:"company_formation"});
    assert.ok(Array.isArray(offers.offerings));
    assert.ok((offers.offerings as Array<{key:string}>).some(x=>x.key==="company_setup_consultation"));
    assert.ok((offers.offerings as Array<{price?:unknown}>).every(x=>!x.price),"Do not synthesize pricing");
    const correctionContext:TrustedToolContext={...context,sourceCustomerMessageId:correctionMessageId};
    await invoke("record_ticket_facts",{
      intentKey:"company_formation",facts:[{key:"visa_count",value:2}],
    },correctionContext);
    const stored=await new ConversationContextRepository(db).read(scope,ticketId);
    assert.equal(stored.activeIntent,"company_formation");
    assert.equal(stored.knownFacts.visa_count,2);
    assert.equal(stored.knownFacts.office_preference,"shared office");
    const events=await db.withAgent(identity.id,async client=>{
      const result=await client.query<{ count:string }>(
        "SELECT count(*) FROM ticket_fact_events WHERE agent_id=$1 AND ticket_id=$2 AND source_message_id=$3",
        [identity.id,ticketId,correctionMessageId],
      );
      return Number(result.rows[0]?.count??0);
    });
    assert.equal(events,1,"Customer correction must retain provenance");
    const denied=await registry.execute({
      name:"execute_workflow",callId:"forbidden",argumentsJson:"{}",
    },context);
    assert.equal(denied.ok,false,"No workflow tool must be callable in P3");
    console.log("P3 intent smoke PASS: all five Node tools, known facts, correction audit, prohibited workflow");
  } finally {
    await db.close();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
