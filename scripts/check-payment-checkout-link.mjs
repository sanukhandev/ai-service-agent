#!/usr/bin/env node
/** Offline checkout reopen regression: no provider order POST, no invoice. */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {PaymentOperations} from "../services/api/dist/runtime/payment-operations.js";
import {existingCheckoutUrl} from "../services/api/dist/runtime/payment-evidence.js";
import {workerTicketScope} from "../services/api/dist/repositories/types.js";

const agentId=randomUUID(),ticketId=randomUUID(),paymentId=randomUUID(),quotationId=randomUUID();
const orderReference="qMuVt5OEA";
const providerPaymentId="1da7bc55-dad9-4a15-a490-dda0abf3d3d1";
const externalReference="ANCFZ-"+paymentId.replaceAll("-","");
const amount="30150.00";
const url="https://mockgateway.com/pg/pay/"+providerPaymentId;
const scope=workerTicketScope(agentId,ticketId);
const saved={APP_ENV:process.env.APP_ENV,ANCFZ_N8N_WEBHOOK_SECRET:process.env.ANCFZ_N8N_WEBHOOK_SECRET};
const oldFetch=globalThis.fetch;
const payment={state:"order_created_checkout_unavailable",order_reference:orderReference,
  provider_payment_id:providerPaymentId,checkout_url:null};
let status="PENDING",external=externalReference,gatewayCalls=0,eventSequence=0,events=[];
const client={query:async(sql,args=[])=>{
  if(sql.startsWith("SELECT * FROM tickets WHERE agent_id"))
    return {rows:[{id:ticketId}]};
  if(sql.startsWith("SELECT id FROM agents WHERE id="))
    return {rows:[{id:agentId}]};
  if(sql.includes("JOIN ticket_quotations q"))
    return {rows:[{...payment,quotation_id:quotationId,
      external_reference:externalReference,amount,currency:"AED"}]};
  if(sql.includes("FROM ticket_events WHERE")&&sql.includes("checkout_link_reopened"))
    return {rows:events.some(e=>e.event_type==="payment.checkout_link_reopened")?[{exists:1}]:[]};
  if(sql.includes("SELECT state,order_reference,provider_payment_id")&&sql.includes("FOR UPDATE"))
    return {rows:[payment]};
  if(sql.includes("SET checkout_url=$4")){
    assert.equal(args[3],url);payment.checkout_url=args[3];return {rows:[]};
  }
  if(sql.startsWith("UPDATE tickets SET last_event_sequence")){
    eventSequence++;return {rows:[{last_event_sequence:String(eventSequence)}]};
  }
  if(sql.startsWith("INSERT INTO ticket_events")){
    const event={id:randomUUID(),ticket_id:ticketId,sequence:String(eventSequence),
      event_type:args[3],payload:JSON.parse(args[4]),created_at:new Date()};
    events.push(event);return {rows:[event]};
  }
  throw Error("Unexpected SQL in checkout reopen test: "+sql.slice(0,150));
}};
const db={withAgent:async(id,fn)=>{assert.equal(id,agentId);return fn(client)}};
try{
  process.env.APP_ENV="development";
  process.env.ANCFZ_N8N_WEBHOOK_SECRET="r".repeat(40);
  globalThis.fetch=async(requestUrl,options)=>{
    // Internal POST requests a read-only gateway GET through n8n.
    // No /payment-link or mockgateway order POST is permitted.
    assert.equal(requestUrl,"http://n8n:5678/webhook/ancfz/payment-verify");
    assert.equal(options.method,"POST");
    const body=JSON.parse(options.body);
    assert.equal(body.orderReference,orderReference);
    assert.equal(body.providerPaymentId,providerPaymentId);
    assert.equal(body.externalReference,externalReference);
    assert.equal(body.amount,amount);
    assert.equal(body.currency,"AED");
    gatewayCalls++;
    return Response.json({provider:"2checkout_mock",ticketId,quotationId,
      externalReference:external,orderReference,providerPaymentId,
      amount,currency:"AED",providerStatus:status,
      status:status==="PENDING"?"payment_pending":"verified_test_payment",
      verified:status==="COMPLETE"});
  };

  assert.equal(existingCheckoutUrl(providerPaymentId,null),url);
  assert.equal(existingCheckoutUrl(providerPaymentId,url),url);
  assert.equal(existingCheckoutUrl(providerPaymentId,"https://evil.example/pg/pay/"+providerPaymentId),null);
  assert.equal(existingCheckoutUrl(providerPaymentId,url+"?token=bad"),null);
  assert.equal(existingCheckoutUrl("../external",null),null);
  const service=new PaymentOperations(db);

  const reopened=await service.checkoutLink(scope,ticketId,paymentId);
  assert.equal(reopened.checkoutUrl,url);
  assert.equal(reopened.newOrderCreated,false);
  assert.equal(reopened.paymentCompleted,false);
  assert.equal(reopened.providerStatus,"PENDING");
  assert.equal(payment.state,"order_created_checkout_unavailable");
  assert.equal(payment.checkout_url,url);
  assert.equal(gatewayCalls,1);
  assert.equal(events.length,1);
  assert.equal(events[0].event_type,"payment.checkout_link_reopened");
  assert.equal(events[0].payload.verifiedPayment,false);
  assert(!JSON.stringify(events[0]).includes(url),"Do not put checkout URL in SSE event");

  await assert.rejects(service.checkoutLink(scope,ticketId,paymentId),
    e=>e.code==="CONFLICT");
  assert.equal(gatewayCalls,1,"Rate limit must reject before gateway access");

  events=[];payment.state="unknown_outcome";
  await assert.rejects(service.checkoutLink(scope,ticketId,paymentId),
    e=>e.code==="CONFLICT");
  assert.equal(gatewayCalls,1,"Unknown orders cannot regenerate a link");

  payment.state="payment_pending";external="ANCFZ-other";
  await assert.rejects(service.checkoutLink(scope,ticketId,paymentId),
    e=>e.code==="CONFLICT");
  assert.equal(gatewayCalls,2);
  assert.equal(events.length,0,"A mismatched provider order creates no link event");

  external=externalReference;status="COMPLETE";
  await assert.rejects(service.checkoutLink(scope,ticketId,paymentId),
    e=>e.code==="CONFLICT");
  assert.equal(gatewayCalls,3,"A paid order must use independent verify, not checkout reopen");

  status="PENDING";payment.checkout_url="https://evil.example/pg/pay/"+providerPaymentId;
  await assert.rejects(service.checkoutLink(scope,ticketId,paymentId),
    e=>e.code==="CONFLICT");
  assert.equal(gatewayCalls,3,"Untrusted stored links are never used");

  console.log("Existing checkout reopen PASS: authenticated GET, owner/identity/amount guard, popup event, no new order or invoice");
}finally{
  globalThis.fetch=oldFetch;
  for(const [key,value] of Object.entries(saved)){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
}
