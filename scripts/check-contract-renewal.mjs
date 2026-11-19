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
console.log("ANCFZ renewal offline contract checks PASS: source ownership, separate quote, price snapshot, consent, provenance, paid revision, recovery");
