#!/usr/bin/env node
// Strict offline regression for the owner-scoped ANCFZ sandbox contract renewal.
// Live PostgreSQL and the provider sandbox are exercised separately in P3.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const get=(p)=>readFileSync(p,"utf8");
const migration=get("infra/postgres/020_contract_renewals.sql");
const migrate=get("infra/bootstrap/apply-migrations.sh");
const backend=get("services/api/src/runtime/contract-renewal-operations.ts");
const api=get("services/api/src/runtime/app.ts");
const quotes=get("services/api/src/runtime/quotation-operations.ts");
const payments=get("services/api/src/runtime/payment-operations.ts");
const worker=get("services/api/src/runtime/service-contract-worker.ts");
const ui=get("apps/web/components/chat-journey-controls.tsx");
const customer=get("apps/web/components/customer-chat.tsx");
const messages=get("services/api/src/repositories/messages.ts");

for(const marker of [
  "ticket_contract_renewals","FORCE ROW LEVEL SECURITY",
  "UNIQUE(agent_id,request_id)","UNIQUE(agent_id,renewal_ticket_id)",
  "ticket_contract_renewals_one_pending","source_document_sha256",
  "renewal_of_contract_id","source_revision","contract_number","GRANT SELECT,INSERT"
])assert.ok(migration.includes(marker),"migration missing: "+marker);
assert.match(migrate,/020_contract_renewals\.sql/);
assert.match(backend,/APP_ENV==="development"/);
assert.match(backend,/ANCFZ_RENEWAL_ENABLED==="true"/);
assert.match(backend,/authorizedTicket\(client,scope,sourceTicketId,true\)/);
assert.match(backend,/c\.state='verified_completed' AND c\.bytes IS NOT NULL/);
assert.match(backend,/p\.state='verified_test_payment'/);
assert.match(backend,/inv\.state='verified_completed' AND inv\.bytes IS NOT NULL/);
assert.match(backend,/source\.sha256/);
assert.match(backend,/assertIdentityDocumentsReadyTx/);
assert.match(backend,/renewal_\[a-z0-9_\]/);
assert.match(backend,/pr\.amount>0 AND pr\.currency='AED'/);
assert.match(backend,/x\.priceRevision===input\.priceRevision/);
assert.match(backend,/renewalReuse:true/);
assert.match(backend,/reused_verified_lead/);
assert.match(backend,/QUOTATION_ACKNOWLEDGMENT/);
assert.match(backend,/new QuotationOperations\(this\.db\)\.submit/);
assert.doesNotMatch(backend,/LeadOperations[\s\S]*\.submit/);
assert.match(quotes,/ticket_contract_renewals r/);
assert.match(quotes,/o\.offering_key ~ '\^renewal_/);
assert.match(quotes,/NOT EXISTS\(\s*SELECT 1 FROM ticket_contract_renewals r/);
assert.match(payments,/renewalLinkTx/);
assert.match(payments,/renewal\.source_revision\+1/);
assert.match(payments,/renewal\.contract_number/);
assert.match(payments,/renewal\.source_contract_id/);
assert.match(payments,/renewalTicket\.rows\.length && !renewal/);
assert.match(worker,/renewalRecord\.rows\.length && !renewal/);
assert.match(payments,/quoted\.amount!==renewal\.amount/);
assert.match(worker,/contractPostPaymentEnabled/);
assert.match(worker,/recoverMissingContract/);
assert.match(worker,/renewalLinkTx/);
assert.match(worker,/status='completed',completed_at=now\(\)/);
assert.match(worker,/i\.state='verified_completed'/);
assert.match(api,/contracts\/:contractId\/renewal\/preview/);
assert.match(api,/contracts\/:contractId\/renewal\/start/);
assert.match(api,/rejectCrossSite\(request\)/);
assert.match(messages,/createCustomerMessageTx/);
assert.match(ui,/Renew this agreement/);
assert.match(ui,/consentText:preview\.disclosure/);
assert.match(ui,/renewalRequestId\.current/);
assert.match(customer,/onRenewalCreated/);
// Synthetic prices are intentionally distinguished from real published fees.
const catalog=JSON.parse(get("infra/catalog/ancfz-test-2026.json"));
assert.equal(catalog.environment,"test");
assert.match(catalog.reviewStatus,/synthetic renewal rates/i);
for(const [years,amount] of [[1,999],[2,1998],[3,2997]]){
  const offer=catalog.offerings.find(x=>x.key==="renewal_test_y"+years);
  assert.ok(offer,"Missing TEST rate for "+years+" years");
  assert.equal(offer.intentKey,"company_formation");
  assert.equal(offer.price.currency,"AED");
  assert.equal(offer.price.amount,amount);
  assert.match(offer.price.conditions,/SYNTHETIC TEST AMOUNT ONLY/);
}
assert.match(get("docker-compose.yml"),/ANCFZ_RENEWAL_ENABLED:/);
assert.ok(api.includes('/renewal/lookup'));
assert.ok(backend.includes('async lookupByLicence('));
assert.ok(backend.includes('ANCFZ-TEST-SC-'));
assert.ok(backend.includes('authorizedTicket(client,scope,ticketId,true)'));
assert.ok(backend.includes('await this.source(client,scope,sourceTicketId,contractId)'));
assert.ok(backend.includes('renewal.lookup.attempt'));
const licenceUi=get("apps/web/components/chat-renewal-lookup.tsx");
assert.match(get("apps/web/components/customer-chat.tsx"),/ChatRenewalLookup/);
assert.ok(licenceUi.includes('result.sourceTicketId'));
assert.ok(licenceUi.includes('consentText:result.preview.disclosure'));
const n8n=JSON.parse(get("infra/n8n/ancfz/08-test-licence-contract-lookup.json"));
assert.equal(n8n.active,false);
assert.equal(n8n.settings.saveDataSuccessExecution,"none");
assert.equal(n8n.settings.saveDataErrorExecution,"none");
assert.ok(n8n.nodes.every(x=>!["n8n-nodes-base.httpRequest","n8n-nodes-base.emailSend"].includes(x.type)));
const webhook=n8n.nodes.find(x=>x.type==="n8n-nodes-base.webhook");
assert.equal(webhook.parameters.authentication,"headerAuth");
assert.equal(webhook.parameters.path,"ancfz/contract-licence-lookup");
const dataTable=n8n.nodes.find(x=>x.type==="n8n-nodes-base.dataTable");
assert.equal(dataTable.parameters.operation,"get");
assert.equal(dataTable.parameters.dataTableId.value,"ANCFZ_POC_CONTRACTS");
assert.equal(dataTable.parameters.filters.conditions[0].keyName,"contractNumber");
const validate=n8n.nodes.find(x=>x.name==="Validate Synthetic Licence");
const run=new Function("$input",validate.parameters.jsCode);
const input=body=>({first:()=>({json:{body}})});
const testReq={agentKey:"ancfz",ticketId:"11111111-1111-4111-8111-111111111111",
  licenceNumber:"ANCFZ-TEST-SC-2026-000001"};
assert.equal(run(input(testReq))[0].json.contractNumber,"ANCFZ-SC-2026-000001");
assert.throws(()=>run(input({...testReq,agentKey:"other"})),/Invalid synthetic licence/);
assert.throws(()=>run(input({...testReq,licenceNumber:"ANCFZ-SC-2026-000001"})),/Invalid synthetic licence/);
const sanitize=n8n.nodes.find(x=>x.name==="Return Contract Mapping");
const clean=new Function("$","$input",sanitize.parameters.jsCode);
const lookup=()=>({first:()=>({json:{contractNumber:"ANCFZ-SC-2026-000001"}})});
const items=rows=>({all:()=>rows.map(json=>({json}))});
assert.equal(clean(lookup,items([]))[0].json.status,"not_found");
const row={contractNumber:"ANCFZ-SC-2026-000001",status:"verified_completed",
  contractId:"11111111-1111-4111-8111-111111111111",
  ticketId:"22222222-2222-4222-8222-222222222222",revision:1};
assert.equal(clean(lookup,items([row]))[0].json.status,"found");
assert.equal(clean(lookup,items([row,{...row,contractId:"33333333-3333-4333-8333-333333333333"}]))[0].json.status,"review");

console.log("ANCFZ renewal offline contract checks PASS: source ownership, separate quote, price snapshot, consent, provenance, paid revision, recovery");
