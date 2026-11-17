#!/usr/bin/env node
/** Provider-free recovery regression. No external gateway, secrets, DB, or new order POST. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {PaymentOperations} from "../services/api/dist/runtime/payment-operations.js";
import {workerTicketScope} from "../services/api/dist/repositories/types.js";
const agentId=randomUUID(),ticketId=randomUUID(),paymentId=randomUUID(),quotationId=randomUUID();
const orderReference="456789234",providerPaymentId="a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  externalReference="ANCFZ-"+paymentId.replaceAll("-","");
const scope=workerTicketScope(agentId,ticketId);
const saved={APP_ENV:process.env.APP_ENV,ANCFZ_N8N_WEBHOOK_SECRET:process.env.ANCFZ_N8N_WEBHOOK_SECRET};
const oldFetch=globalThis.fetch;
const record={state:"unknown_outcome",order_reference:null,provider_payment_id:null,
  outbox_status:"dead",attempts:1,
  verification_attempts:0,next_verification_at:new Date(0)};
let remoteStatus="PENDING",remoteAmount="30150.00",calls=[],events=[];
const client={query:async(sql,args=[])=>{
  if(sql.startsWith("SELECT * FROM tickets WHERE agent_id"))return {rows:[{id:ticketId}]};
  if(sql.startsWith("SELECT id FROM agents WHERE id="))return {rows:[{id:agentId}]};
  if(sql.includes("e.status AS outbox_status"))
    return {rows:[{...record,quotation_id:quotationId,external_reference:externalReference,
      amount:"30150.00",currency:"AED"}]};
  if(sql.includes("SET\n           verification_attempts=verification_attempts+1")){
    record.verification_attempts++;
    record.next_verification_at=new Date(Date.now()+60_000);
    return {rows:[]};
  }
  if(sql.includes("SELECT state,order_reference FROM ticket_payment_attempts"))
    return {rows:[{state:record.state,order_reference:record.order_reference}]};
  if(sql.includes("SET order_reference=$4")){
    record.order_reference=args[3];record.provider_payment_id=args[4];
    record.state="order_created_checkout_unavailable";
    return {rows:[]};
  }
  if(sql.includes("UPDATE tickets SET last_event_sequence"))
    return {rows:[{last_event_sequence:"1"}]};
  if(sql.includes("INSERT INTO ticket_events")){
    events.push({type:args[3],payload:JSON.parse(args[4])});
    return {rows:[{id:randomUUID(),ticket_id:ticketId,sequence:"1",
      event_type:args[3],payload:JSON.parse(args[4]),created_at:new Date()}]};
  }
  throw Error("Unexpected SQL in reconciliation regression: "+sql.slice(0,130));
}};
const db={withAgent:async(id,fn)=>{assert.equal(id,agentId);return fn(client)}};
function reset(){record.state="unknown_outcome";record.order_reference=null;
  record.provider_payment_id=null;
  record.verification_attempts=0;record.next_verification_at=new Date(0);
  calls=[];events=[];}
try{
  process.env.APP_ENV="development";
  process.env.ANCFZ_N8N_WEBHOOK_SECRET="w".repeat(40);
  globalThis.fetch=async(url,opts)=>{
    assert.equal(url,"http://n8n:5678/webhook/ancfz/payment-verify");
    assert.equal(opts.method,"POST");
    const body=JSON.parse(opts.body);
    assert.equal(body.orderReference,orderReference);
    assert.equal(body.providerPaymentId,providerPaymentId);
    assert.equal(body.externalReference,externalReference);
    calls.push(url);
    return Response.json({
      provider:"2checkout_mock",ticketId,quotationId,externalReference,orderReference,
      providerPaymentId,
      amount:remoteAmount,currency:"AED",providerStatus:remoteStatus,
      status:remoteStatus==="COMPLETE"?"verified_test_payment":"payment_pending",
      verified:remoteStatus==="COMPLETE",
    });
  };
  const service=new PaymentOperations(db);
  const ok=await service.reconcile(scope,ticketId,paymentId,{orderReference,providerPaymentId});
  assert.equal(ok.reconciled,true);
  assert.equal(ok.paymentCompleted,false);
  assert.equal(ok.providerStatus,"PENDING");
  assert.equal(record.order_reference,orderReference);
  assert.equal(record.provider_payment_id,providerPaymentId);
  assert.equal(record.state,"order_created_checkout_unavailable");
  assert.deepEqual(calls,["http://n8n:5678/webhook/ancfz/payment-verify"]);
  assert.equal(events[0]?.type,"payment.order_reconciled");
  assert.equal(events[0]?.payload.verifiedPayment,false);
  await assert.rejects(service.reconcile(scope,ticketId,paymentId,{orderReference,providerPaymentId}),
    e=>e.code==="CONFLICT");
  assert.equal(calls.length,1,"Reconciliation must not repeat after attaching an order");
  reset();remoteAmount="30150.01";
  await assert.rejects(service.reconcile(scope,ticketId,paymentId,{orderReference,providerPaymentId}),
    e=>e.code==="CONFLICT");
  assert.equal(record.order_reference,null,"Price mismatch must not attach an order");
  assert.equal(record.verification_attempts,1,"Failed lookup counts against rate limit");
  assert.equal(events.length,0);
  reset();remoteAmount="30150.00";remoteStatus="COMPLETE";
  const paid=await service.reconcile(scope,ticketId,paymentId,{orderReference,providerPaymentId});
  assert.equal(paid.paymentCompleted,false,"COMPLETE recovery is not invoice authorization");
  assert.equal(record.state,"order_created_checkout_unavailable");
  assert.equal(events[0].payload.verifiedPayment,false);
  reset();
  await assert.rejects(service.reconcile(scope,ticketId,paymentId,{
    orderReference:orderReference+"!",providerPaymentId}),
    e=>e.code==="INVALID_INPUT");
  assert.equal(calls.length,0,"Invalid reference must not contact gateway");
  console.log("GET-only reconciliation PASS: exact identity, amount, bounded retries, no order POST, no invoice");
}finally{
  globalThis.fetch=oldFetch;
  for(const [key,value] of Object.entries(saved)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
