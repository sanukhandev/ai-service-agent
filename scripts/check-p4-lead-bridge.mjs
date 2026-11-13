#!/usr/bin/env node
/** Offline P4 safety gate: never contacts Foundry, n8n or Salesforce. */
import assert from "node:assert/strict";
import { parseAuthorizedLead, leadDispatchEnabled, verifiedLeadResult, LEAD_CONSENT_TEXT } from "../services/api/dist/runtime/lead-operations.js";

const input = {
  requestId:"11111111-1111-4111-8111-111111111111",
  name:"POC Example",company:"Example LLC",phone:"+971 555555555",
  email:"EXAMPLE@example.invalid",description:"Disposable test enquiry",
  consent:true,consentText:LEAD_CONSENT_TEXT,
};
const parsed=parseAuthorizedLead(input);
assert.equal(parsed.lead.email,"example@example.invalid");
assert.equal(parsed.digest.length,64);
assert.throws(()=>parseAuthorizedLead({...input,consent:false}));
assert.throws(()=>parseAuthorizedLead({...input,consentText:"yes"}));
assert.throws(()=>parseAuthorizedLead({...input,email:"invalid"}));
assert.throws(()=>parseAuthorizedLead({...input,agentId:"model-supplied"}));
assert.equal(leadDispatchEnabled({ANCFZ_LEAD_DISPATCH_ENABLED:"false",ANCFZ_N8N_WEBHOOK_SECRET:"z".repeat(40)}),false);
assert.equal(leadDispatchEnabled({ANCFZ_LEAD_DISPATCH_ENABLED:"true",ANCFZ_N8N_WEBHOOK_SECRET:"short"}),false);
assert.equal(leadDispatchEnabled({ANCFZ_LEAD_DISPATCH_ENABLED:"true",ANCFZ_N8N_WEBHOOK_SECRET:"z".repeat(40)}),true);
const ticketId="22222222-2222-4222-8222-222222222222";
const leadId="00Q"+"a".repeat(15);
assert.equal(verifiedLeadResult({status:"verified_completed",verified:true,ticketId,leadId},ticketId),leadId);
assert.equal(verifiedLeadResult({status:"verified_completed",verified:false,ticketId,leadId},ticketId),null);
assert.equal(verifiedLeadResult({status:"verified_completed",verified:true,ticketId:"wrong",leadId},ticketId),null);
assert.equal(verifiedLeadResult({status:"provider_acknowledged_unverified",verified:true,ticketId,leadId},ticketId),null);
assert.equal(verifiedLeadResult({status:"verified_completed",verified:true,ticketId,leadId:"fake"},ticketId),null);
assert.equal(verifiedLeadResult(null,ticketId),null);
console.log("P4 ANCFZ lead bridge safety checks PASS: consent, bounds, disabled-by-default, verified provider evidence");
