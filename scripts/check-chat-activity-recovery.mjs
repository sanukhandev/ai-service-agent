#!/usr/bin/env node
/** Ticket #58: business activity answer must not be discarded into an
 * endless Node-authored missing-fact question. Provider/DB-free regression. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {sourcedBusinessActivityReply} from "../services/api/dist/runtime/chat-fact-reconciliation.js";

const question="What business activity will your company perform?";
const reply=(customerText,more={})=>sourcedBusinessActivityReply({
  previousAssistant:question,
  customerText,
  requestedAction:"generate_quote",
  missingBusinessActivity:true,
  ...more,
});
for(const activity of ["AI BUILDINGS","it ai services","IT COMPAAANY",
  "Software engineering and AI consulting","digital marketing","Construction"]) {
  assert.equal(reply(activity),activity,
    "Do not discard a directly provided, source-linked business activity");
}
for(const irrelevant of ["YES","SERVICES","AI COMPANY","I don't know",
  "Please generate a quotation","I Consent","Can I pay now?",
  "sanu@example.invalid","123456789","Cancel",
  "What documents do I need?"]) {
  assert.equal(reply(irrelevant),null,
    "Do not infer an activity from unrelated or ambiguous chat");
}
assert.equal(reply("it ai services",{previousAssistant:"Do you need a visa?"}),null);
assert.equal(reply("it ai services",{previousAssistant:null}),null);
assert.equal(reply("it ai services",{requestedAction:null}),null);
assert.equal(reply("it ai services",{requestedAction:"purchase_quotation"}),null);
assert.equal(reply("it ai services",{missingBusinessActivity:false}),null);
assert.equal(reply("it ai services\nI approve"),null);
const worker=readFileSync("services/api/src/runtime/turn-worker.ts","utf8");
assert.match(worker,/displayHistory\.at\(-1\)\?\.id===turn\.messageId/);
assert.match(worker,/this\.context\.recordCustomerFacts\(scope,turn\.ticketId,turn\.messageId,/);
assert.match(worker,/\[\{key:"business_activity",value:activity\}\]/);
assert.match(worker,/stored=await this\.context\.read\(scope,turn\.ticketId\)/);
assert.match(worker,/handoffBefore=await handoff\.status\(scope,turn\.ticketId,requestedAction\.action\)/);
console.log("Ticket #58 activity-loop recovery PASS: immediate answer, source provenance, unrelated-message guard");
