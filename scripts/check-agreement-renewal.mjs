#!/usr/bin/env node
/** Offline numbering, renewal, and n8n register contract checks. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {RENEWAL_START_CONSENT,RENEWAL_PURCHASE_CONSENT} from
  "../services/api/dist/runtime/renewal-operations.js";

assert.match(RENEWAL_START_CONSENT,/fresh ANCFZ sandbox renewal quotation/);
assert.match(RENEWAL_PURCHASE_CONSENT,/updated nonbinding TEST service agreement/);
const src=p=>readFileSync(p,"utf8");
const sql=src("infra/postgres/019_service_agreements.sql");
const renewalSql=src("infra/postgres/020_agreement_renewals.sql");
const purchase=src("services/api/src/runtime/purchase-operations.ts");
const payment=src("services/api/src/runtime/payment-operations.ts");
const worker=src("services/api/src/runtime/service-contract-worker.ts");
const renew=src("services/api/src/runtime/renewal-operations.ts");
const invoice=src("services/api/src/runtime/n8n-invoice-worker.ts");
const frontend=src("apps/web/components/chat-journey-controls.tsx");
const chat=src("apps/web/components/customer-chat.tsx");

for(const expected of [
 "service_agreements","agreement_number","current_revision",
 "ticket_service_contracts_agreement_revision_uq",
 "ticket_payment_invoices_scoped_id_unique",
 "sync_state","FORCE ROW LEVEL SECURITY"
])assert.ok(sql.includes(expected),expected);
assert.match(renewalSql,/ticket_renewals_one_requested_per_agreement/);
assert.match(renewalSql,/FORCE ROW LEVEL SECURITY/);
assert.match(payment,/currentRenewal\?RENEWAL_PURCHASE_CONSENT:PURCHASE_CONSENT/);
assert.match(payment,/currentRenewal\.current_revision\+1/);
assert.match(payment,/agreementNumber\+"-R"/);
assert.match(worker,/c\.agreementNumber/);
assert.match(worker,/c\.invoiceNumber/);
assert.match(worker,/c\.quoteNumber/);
assert.match(worker,/i\.state='verified_completed'/);
assert.match(worker,/p\.state='verified_test_payment'/);
assert.match(worker,/syncAgreement\(agentId\)/);
assert.match(worker,/UPDATE ticket_renewals SET status='completed'/);
assert.match(worker,/recoverMissingContracts\(agentId\)/);
assert.match(renew,/authorizedTicket\(client,scope,sourceTicketId,true\)/);
assert.match(renew,/current_revision>=1/);
assert.match(renew,/RENEWAL_START_CONSENT/);
assert.match(renew,/operation_key='ancfz_salesforce_lead' AND state='verified_completed'/);
assert.match(renew,/newPaymentRequired:true/);
assert.match(purchase,/renewalAgreementNumber/);
assert.match(purchase,/RENEWAL_PURCHASE_CONSENT/);
assert.match(invoice,/a\.initial_ticket_id/);
assert.match(frontend,/Renew this agreement/);
assert.match(frontend,/RENEWAL_START_CONSENT/);
assert.match(chat,/onRenewalCreated/);
assert.doesNotMatch(frontend,/onClick=\{\(\)=>\{void verifyExistingPayment\(\);\}\}/);

const wf=JSON.parse(src("infra/n8n/ancfz/07-agreement-register.json"));
assert.equal(wf.active,false);
assert.equal(wf.name,"ANCFZ | Agreement Register Data Table (LOCAL ONLY)");
assert.equal(wf.nodes.filter(n=>n.type==="n8n-nodes-base.webhook").length,1);
const hook=wf.nodes.find(n=>n.name==="Receive Node Agreement");
assert.equal(hook.parameters.authentication,"headerAuth");
assert.equal(hook.parameters.path,"ancfz/agreement-register");
const upsert=wf.nodes.find(n=>n.name==="Upsert Agreement in Data Table");
assert.equal(upsert.parameters.operation,"upsert");
assert.equal(upsert.parameters.dataTableId.value,"ANCFZ_POC_AGREEMENTS");
assert.equal(upsert.parameters.matchType,"allConditions");
assert.equal(upsert.parameters.filters.conditions[0].keyName,"agreementNumber");
assert.equal(wf.nodes.some(n=>n.type==="n8n-nodes-base.emailSend"),false);
const validate=wf.nodes.find(n=>n.name==="Validate Agreement Sync");
const exec=new Function("$input",validate.parameters.jsCode);
const body={agentKey:"ancfz",testOnly:true,
 agreementNumber:"ANCFZ-AGR-2026-000001",revision:2,
 ticketId:"11111111-1111-4111-8111-111111111111",
 quotationNumber:"ANCFZ-TEST-Q-22222222-2222-4222-8222-222222222222",
 invoiceNumber:"ANCFZ-TEST-INV-33333333-3333-4333-8333-333333333333",
 status:"verified_completed"};
const input=b=>({first:()=>({json:{body:b}})});
assert.equal(exec(input(body))[0].json.agreementNumber,body.agreementNumber);
assert.equal(exec(input(body))[0].json.revision,2);
assert.throws(()=>exec(input({...body,revision:-1})),/Invalid revision/);
assert.throws(()=>exec(input({...body,invoiceNumber:"spoofed"})),/Invalid invoice/);
assert.throws(()=>exec(input({...body,testOnly:false})),/Sandbox agreement/);
assert.throws(()=>exec(input({...body,status:"queued"})),/verified completed/);
console.log("ANCFZ agreement static contracts PASS: stable numbering, exact consent, renewal versioning, no PII sync");
