#!/usr/bin/env node
/** Ticket #58: a directly supplied activity must be validated and source-linked;
 * a vague answer must produce specific guidance, not the same question again. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {recoverSourcedAnswer} from "../services/api/dist/runtime/chat-fact-reconciliation.js";
import {validateConversationFact} from "../services/api/dist/runtime/fact-validation.js";

const question="What business activity will your company perform?";
const reply=(customerText,more={})=>recoverSourcedAnswer({
  previousAssistant:question,
  customerText,requestedAction:"generate_quote",
  activeIntent:"company_formation",knownFacts:{},
  missingRequirements:["business_activity"],
  ...more,
});
for(const activity of ["it ai services","Software engineering and AI consulting",
  "digital marketing","Construction"]) {
  const candidates=reply(activity);
  assert.deepEqual(candidates,[{key:"business_activity",value:activity}],
    "Do not discard an immediate source-linked business activity");
  assert.equal(validateConversationFact("business_activity",activity,"text").status,"accepted");
}
for(const ambiguous of ["AI BUILDINGS","AI COMPANY","IT COMPAAANY","SERVICES"]) {
  const candidate=reply(ambiguous)[0];
  if(candidate)assert.equal(validateConversationFact(candidate.key,candidate.value,"text").status,
    "needs_clarification","Ambiguous activity must not be treated as complete");
}
for(const irrelevant of ["YES","I don't know","Please generate a quotation",
  "I Consent","Can I pay now?","sanu@example.invalid","123456789","Cancel",
  "What documents do I need?"]) {
  assert.deepEqual(reply(irrelevant),[],"Never extract from unrelated chat");
}
assert.deepEqual(reply("it ai services",{previousAssistant:"Do you need a visa?"}),[]);
assert.deepEqual(reply("it ai services",{previousAssistant:null}),[]);
assert.deepEqual(reply("it ai services",{requestedAction:null}),[]);
assert.deepEqual(reply("it ai services",{requestedAction:"purchase_quotation"}),[]);
assert.deepEqual(reply("it ai services",{missingRequirements:[]}),[]);
const worker=readFileSync("services/api/src/runtime/turn-worker.ts","utf8");
assert.match(worker,/displayHistory\.at\(-1\)\?\.id===turn\.messageId/);
assert.match(worker,/recoverSourcedAnswer/);
assert.match(worker,/this\.context\.recordCustomerFacts\(scope,turn\.ticketId,turn\.messageId,/);
assert.match(worker,/stored=await this\.context\.read\(scope,turn\.ticketId\)/);
console.log("Ticket #58 activity-loop recovery PASS: immediate validated answers, provenance and no unsupported inference");
