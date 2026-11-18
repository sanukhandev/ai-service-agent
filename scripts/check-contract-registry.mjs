#!/usr/bin/env node
/** Offline contract registry + document reference + n8n safety checks. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(p,"utf8");
const migration=read("infra/postgres/019_contract_registry.sql");
const contract=read("services/api/src/runtime/service-contract-worker.ts");
const pay=read("services/api/src/runtime/payment-operations.ts");
const bootstrap=read("infra/bootstrap/apply-migrations.sh");
const flow=JSON.parse(read("infra/n8n/ancfz/07-mock-contract-registry.json"));
const workflow=flow.nodes;
assert.match(bootstrap,/019_contract_registry.sql/);
assert.match(migration,/CREATE SEQUENCE ancfz_service_contract_number_seq/);
assert.match(migration,/contract_number varchar\(40\)/);
assert.match(migration,/ticket_contracts_number_revision_unique/);
assert.match(migration,/renewal_of_contract_id/);
assert.match(contract,/i\.state='verified_completed'/);
assert.match(contract,/invoice_document_number/);
assert.match(contract,/Contract number: /);
assert.match(contract,/Invoice number: /i);
assert.match(contract,/XXXX-XXXX-XXXX-/);
assert.match(contract,/contract\.registry_synced/);
assert.match(contract,/registry_sync_state='synced'/);
assert.match(contract,/approved_package_scope_missing/);
assert.match(pay,/contract_number/);
assert.match(pay,/failureCode:contract\.rows\[0\]\.failure_code/);
assert.equal(flow.active,false);
assert.equal(flow.settings.saveDataSuccessExecution,"none");
assert.equal(flow.settings.saveDataErrorExecution,"none");
assert.ok(!workflow.some(x=>x.type==="n8n-nodes-base.emailSend"));
const wh=workflow.find(x=>x.name==="Receive Contract Registry");
const guard=workflow.find(x=>x.name==="Validate Contract Registry");
const upsert=workflow.find(x=>x.name==="Upsert Contract Registry");
assert.equal(wh.parameters.authentication,"headerAuth");
assert.equal(wh.parameters.path,"ancfz/contract-registry");
assert.equal(upsert.parameters.operation,"upsert");
assert.equal(upsert.parameters.matchType,"allConditions");
assert.equal(upsert.parameters.dataTableId.value,"ANCFZ_POC_CONTRACTS");
assert.equal(upsert.parameters.filters.conditions[0].keyName,"contractId");
const validate=new Function("$input",guard.parameters.jsCode);
const body={
 agentKey:"ancfz",testOnly:true,
 contractId:"11111111-1111-4111-8111-111111111111",
 contractNumber:"ANCFZ-SC-2026-000001",revision:1,
 ticketId:"22222222-2222-4222-8222-222222222222",
 quoteNumber:"ANCFZ-TEST-Q-33333333-3333-4333-8333-333333333333",
 invoiceNumber:"ANCFZ-TEST-INV-44444444-4444-4444-8444-444444444444",
 status:"verified_completed",
};
const run=b=>validate({first:()=>({json:{body:b}})});
assert.equal(run(body)[0].json.contractNumber,body.contractNumber);
assert.throws(()=>run({...body,invoiceNumber:"wrong"}),/Invalid invoice number/);
assert.throws(()=>run({...body,revision:0}),/Invalid revision/);
assert.throws(()=>run({...body,testOnly:false}),/Invalid registry scope/);
assert.throws(()=>run({...body,contractNumber:"ANCFZ-SC-2026-000002",contractId:"bad"}),/Invalid registry IDs/);
console.log("Contract registry PASS: stable number, invoice/quote references, masked OCR fallback, n8n upsert and private source guards");
