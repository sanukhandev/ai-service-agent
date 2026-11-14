/** Disposable CI: execute every generic action class with real RLS/ticket facts. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { GuestSessionRepository, TicketRepository } from "../repositories/tickets.js";
import { ConversationContextRepository } from "../repositories/context.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { IntentActionOperations, SERVICE_REQUEST_CONSENT, isServiceAction } from "./intent-action-operations.js";

const exampleValues:Record<string,string|number>={
  visa_count:2,customer_email:"synthetic@example.invalid",
  existing_license_reference:"CI-TEST-LICENCE-123",
  company_status:"incorporated",
  business_activity:"CI test services",activity_category:"IT services",
  term_years:1,requested_change:"CI requested name change",
  visa_type:"residency",applicant_residency_status:"outside UAE",
  office_preference:"shared",desk_count:1,
  package_key:"ci-package",payment_channel:"card",
  business_stage:"early",legal_support_topic:"company setup",
  compliance_topic:"CI compliance",support_topic:"CI support",
  company_structure:"LLC",preferred_office:"Sharjah office",
  parent_jurisdiction:"UAE",parent_trade_license:"CI-TEST-LIC-2",
  manager_details:"CI manager",
};
async function main(){
  if(process.env.P5_INTENT_ACTION_SMOKE!=="1")throw Error("Disposable DB only");
  const db=new PersistenceDatabase(undefined);
  try {
    await db.assertSafeRuntimeRole();
    const agent=await new AgentRepository(db).resolvePublicKey("ancfz");
    assert.ok(agent);
    const session=await new GuestSessionRepository(db).create(agent.id);
    const scope={agentId:agent.id,owner:{kind:"guest" as const,token:session.token}};
    const context=new ConversationContextRepository(db);
    const messages=new TicketMessageRepository(db);
    const actions=new IntentActionOperations(db);
    const candidates=[
      {intent:"visa_services",action:"create_enquiry"},
      {intent:"license_renewal",action:"create_renewal_request"},
      {intent:"banking_assistance",action:"create_referral"},
    ];
    for(const entry of candidates){
      assert(isServiceAction(entry.action));
      const ticket=await new TicketRepository(db).create(scope,"P5 synthetic "+entry.intent);
      await context.selectIntent(scope,ticket.id,entry.intent);
      const before=await actions.catalog(scope,ticket.id);
      assert.equal(before.intentKey,entry.intent);
      assert(before.unknownActions.length===0);
      const selected=before.actions.find(a=>a.actionKey===entry.action);
      assert.ok(selected);
      assert.equal(selected.kind,"ticket_request");
      const request={requestId:randomUUID(),consent:true,consentText:SERVICE_REQUEST_CONSENT};
      const conflict=(err:unknown)=>err instanceof PersistenceError&&err.code==="CONFLICT";
      if(selected.missing.length>0){
        await assert.rejects(()=>actions.submit(scope,ticket.id,entry.action,request),conflict);
        const message=await messages.createCustomerMessage(scope,ticket.id,randomUUID(),
          "CI synthetic service request facts explicitly provided");
        const values=selected.missing.map(key=>{
          const value=exampleValues[key];
          assert.ok(value!==undefined,"Missing CI value for "+key);
          return {key,value};
        });
        await context.recordCustomerFacts(scope,ticket.id,message.message.id,values);
      }
      const updated=await actions.catalog(scope,ticket.id);
      assert.equal(updated.actions.find(a=>a.actionKey===entry.action)?.ready,true);
      await assert.rejects(()=>actions.submit(scope,ticket.id,entry.action,{
        ...request,consent:false,
      }),err=>err instanceof PersistenceError && err.code==="INVALID_INPUT");
      const first=await actions.submit(scope,ticket.id,entry.action,request);
      assert.equal(first.request.status,"awaiting_staff_review");
      assert.equal(first.duplicated,false);
      const second=await actions.submit(scope,ticket.id,entry.action,request);
      assert.equal(second.duplicated,true);
      assert.equal(second.request.id,first.request.id);
      await assert.rejects(()=>actions.submit(scope,ticket.id,entry.action,{
        ...request,requestId:randomUUID(),
      }),conflict);
      await assert.rejects(()=>actions.submit(scope,ticket.id,"create_lead",request),
        err=>err instanceof PersistenceError && err.code==="INVALID_INPUT");
      await assert.rejects(()=>context.selectIntent(scope,ticket.id,"company_formation"),conflict);
      const invalidSession=await new GuestSessionRepository(db).create(agent.id);
      const another={agentId:agent.id,owner:{kind:"guest" as const,token:invalidSession.token}};
      await assert.rejects(()=>actions.catalog(another,ticket.id),
        err=>err instanceof PersistenceError && err.code==="NOT_FOUND");
      const notice=await messages.listTicketMessages(scope,ticket.id);
      assert(notice.some(m=>m.role==="assistant"&&m.text.includes("not submitted")));
      console.log(entry.intent+" "+entry.action+" PASS: customer consent, facts, durable request, idempotency and RLS");
    }
    console.log("P5 generic intent action smoke PASS");
  } finally {await db.close();}
}
main().catch(err=>{console.error(err);process.exitCode=1;});
