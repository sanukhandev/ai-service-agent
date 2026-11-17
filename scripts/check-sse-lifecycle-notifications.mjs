#!/usr/bin/env node
/** Offline lifecycle notification regression checks; no provider or database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LifecycleNoticeRecovery } from "../services/api/dist/runtime/lifecycle-notice-recovery.js";
import {
  lifecycleNoticeId, TicketMessageRepository,
} from "../services/api/dist/repositories/messages.js";

const id = randomUUID();
const leadNotice = lifecycleNoticeId("lead.verified", id);
const paymentNotice = lifecycleNoticeId("payment.verified", id);
assert.match(leadNotice, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(lifecycleNoticeId("lead.verified", id), leadNotice);
assert.notEqual(paymentNotice, leadNotice);
assert.notEqual(lifecycleNoticeId("lead.verified", randomUUID()), leadNotice);
assert.throws(() => lifecycleNoticeId("invalid stage", id));
assert.throws(() => lifecycleNoticeId("lead.verified", "invalid"));

const scope = { agentId: randomUUID(), owner: { kind: "internal" } };
const ticketId = randomUUID();
const requestId = lifecycleNoticeId("payment.verified", id);
const description = "Verified sandbox payment; invoice preparation started";

// Simulate an optional notification insertion failure. A recoverable SQL
// error is isolated to a SAVEPOINT instead of aborting provider finalization.
const failedQueries = [];
const failureClient = { query: async (sql) => { failedQueries.push(sql); } };
const failureRepo = new TicketMessageRepository({});
failureRepo.createAssistantMessageTx = async () => {
  throw Error("Simulated assistant message INSERT failure");
};
assert.equal(
  await failureRepo.tryAssistantLifecycleNoticeTx(
    failureClient, scope, ticketId, requestId, description,
  ),
  false,
);
assert.deepEqual(failedQueries, [
  "SAVEPOINT service_agent_optional_notice",
  "ROLLBACK TO SAVEPOINT service_agent_optional_notice",
  "RELEASE SAVEPOINT service_agent_optional_notice",
]);

// Successful notification must leave the enclosing provider transaction open.
const successQueries = [];
const successClient = { query: async (sql) => { successQueries.push(sql); } };
const successRepo = new TicketMessageRepository({});
let delivered = 0;
successRepo.createAssistantMessageTx = async () => {
  delivered += 1;
  return { duplicated: false, message: {} };
};
assert.equal(
  await successRepo.tryAssistantLifecycleNoticeTx(
    successClient, scope, ticketId, requestId, description,
  ),
  true,
);
assert.equal(delivered, 1);
assert.deepEqual(successQueries, [
  "SAVEPOINT service_agent_optional_notice",
  "RELEASE SAVEPOINT service_agent_optional_notice",
]);
// Regression: ticket_operations has consented_at but no created_at. All three
// recovery stages must select/order only by fields available on their table.
const recoveredQueries = new Map();
const recoveryDb = {
  withAgent: async (agentId, fn) => {
    assert.equal(agentId, scope.agentId);
    return fn({
      query: async (sql, params) => {
        assert.deepEqual(params, [scope.agentId, "test notice"]);
        const stage = sql.includes("ticket_operations op") ? "lead.verified"
          : sql.includes("op.state='verified_test_payment'")
            ? "payment.verified" : "otp.verified";
        recoveredQueries.set(stage, sql);
        return { rows: [] };
      },
    });
  },
};
const recovery = new LifecycleNoticeRecovery(recoveryDb, () => {});
for (const stage of ["lead.verified", "otp.verified", "payment.verified"]) {
  await recovery.candidates(scope.agentId, stage, "test notice");
}
assert.equal(recoveredQueries.size, 3);
assert.match(recoveredQueries.get("lead.verified"), /FROM ticket_operations op/);
assert.match(recoveredQueries.get("lead.verified"), /ORDER BY op\\.consented_at, op\\.id LIMIT 12/);
assert.doesNotMatch(recoveredQueries.get("lead.verified"), /op\\.created_at/);
for (const stage of ["otp.verified", "payment.verified"]) {
  assert.match(recoveredQueries.get(stage), /FROM ticket_payment_attempts op/);
  assert.match(recoveredQueries.get(stage), /ORDER BY op\\.created_at, op\\.id LIMIT 12/);
}

console.log("SSE lifecycle notice contracts PASS: deterministic IDs, failure isolation and successful release");
console.log("Lifecycle notice query ordering PASS: Salesforce consented_at, payment created_at");
