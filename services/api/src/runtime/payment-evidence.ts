/**
 * Server-side 2Checkout mock evidence contracts.
 * Never treat n8n HTTP 200, client redirects or order POST as payment proof.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ref=/^[A-Za-z0-9_-]{1,120}$/;
export const PAYMENT_CONSENT =
  "I authorize an ANCFZ sandbox payment for the exact quotation amount shown and understand that this is a test transaction.";
export interface PaymentIdentity {
  ticketId:string; quotationId:string; externalReference:string;
  amount:string; currency:string;
}
export interface CreatedOrder {
  orderReference:string; providerPaymentId:string|null; checkoutUrl:string|null;
  state:"checkout_available"|"order_created_checkout_unavailable";
}
export interface VerifiedStatus {
  state:"verified_test_payment"|"payment_pending"|"payment_declined"|"payment_refunded";
  verified:boolean; providerStatus:string;
}
export function paymentEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  return env.APP_ENV==="development" && env.ANCFZ_PAYMENT_DISPATCH_ENABLED==="true" &&
    env.ANCFZ_TEST_OTP_ENABLED==="true" && env.ANCFZ_OTP_MOCK_ENABLED==="true" &&
    typeof env.ANCFZ_N8N_WEBHOOK_SECRET==="string" && env.ANCFZ_N8N_WEBHOOK_SECRET.length>=32 &&
    typeof env.ANCFZ_OTP_PEPPER==="string" && env.ANCFZ_OTP_PEPPER.length>=32;
}
export function moneyEqual(a:string,b:string):boolean {
  return /^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(a) && a===b;
}
/** The documented MockGateway GET uses payment_id, not RefNo/OrderNo.
 * The payment ID is the sole path token of the provider's hosted checkout URL
 * in the supplied test API examples. Its identity must be confirmed by GET.
 * Never use it to infer payment completion. */
export function paymentIdFromCheckout(value:unknown):string|null {
  if(typeof value!=="string"||value.length>2048)return null;
  try {
    const u=new URL(value);
    const match=/^\/pg\/pay\/([A-Za-z0-9_-]{1,120})$/.exec(u.pathname);
    if(u.protocol!=="https:"||u.hostname!=="mockgateway.com"||
       u.username||u.password||u.search||u.hash||u.port||!match)return null;
    return match[1];
  }catch{return null;}
}
export function isCheckoutUrl(value:unknown):value is string {
  return paymentIdFromCheckout(value)!==null;
}

/** Reopen the provider's existing sandbox checkout without POSTing an order.
 * The caller must independently verify the stored RefNo, external reference
 * and amount through the authenticated gateway GET before returning this link.
 * Never accept a URL or payment ID from the browser as proof of a payment. */
export function existingCheckoutUrl(
  providerPaymentId:unknown, storedUrl:unknown,
):string|null {
  if(typeof providerPaymentId!=="string"||
     !/^[A-Za-z0-9_-]{1,120}$/.test(providerPaymentId))return null;
  if(storedUrl!==null){
    return typeof storedUrl==="string" &&
      paymentIdFromCheckout(storedUrl)===providerPaymentId ? storedUrl:null;
  }
  const url="https://mockgateway.com/pg/pay/"+providerPaymentId;
  return isCheckoutUrl(url)?url:null;
}
/** Only finite failure categories are retained. Never log provider bodies, URL query
 * parameters, billing data, credentials, or customer identifiers. */
export function inspectCreatedOrder(raw:unknown,expected:PaymentIdentity):
  {created:CreatedOrder|null;reason:string}{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    return {created:null,reason:"post_invalid_json_shape"};
  const v=raw as Record<string,unknown>;
  if(v.provider!=="2checkout_mock"||v.verified!==false)
    return {created:null,reason:"post_provider_contract_invalid"};
  if(v.ticketId!==expected.ticketId||v.quotationId!==expected.quotationId||
     v.externalReference!==expected.externalReference)
    return {created:null,reason:"post_order_identity_mismatch"};
  if(v.amount!==expected.amount||v.currency!==expected.currency)
    return {created:null,reason:"post_order_price_mismatch"};
  if(typeof v.orderReference!=="string"||!ref.test(v.orderReference))
    return {created:null,reason:"post_order_reference_invalid"};
  if(v.status==="checkout_available"&&isCheckoutUrl(v.checkoutUrl)){
    const paymentId=paymentIdFromCheckout(v.checkoutUrl);
    if(v.providerPaymentId!==undefined&&v.providerPaymentId!==paymentId)
      return {created:null,reason:"post_provider_payment_id_mismatch"};
    return {created:{state:"checkout_available",orderReference:v.orderReference,
      providerPaymentId:paymentId,checkoutUrl:v.checkoutUrl},reason:"validated"};
  }
  if(v.status==="order_created_checkout_unavailable"&&v.checkoutUrl===null)
    return {created:{state:"order_created_checkout_unavailable",
      orderReference:v.orderReference,providerPaymentId:null,
      checkoutUrl:null},reason:"validated"};
  return {created:null,reason:"post_checkout_contract_invalid"};
}
export function verifyCreatedOrder(raw:unknown,expected:PaymentIdentity):CreatedOrder|null {
  return inspectCreatedOrder(raw,expected).created;
}
/** Read-only order checks may continue after outbound order POSTs are disabled.
 * This lets operators quarantine a faulty integration without losing the
 * ability to verify existing orders. */
export function paymentReadEnabled(env:NodeJS.ProcessEnv=process.env):boolean{
  return env.APP_ENV==="development" &&
    typeof env.ANCFZ_N8N_WEBHOOK_SECRET==="string" &&
    env.ANCFZ_N8N_WEBHOOK_SECRET.length>=32;
}
export function verifyPaymentStatus(raw:unknown,expected:PaymentIdentity & {orderReference:string}):VerifiedStatus|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  if(!uuid.test(expected.ticketId)||!uuid.test(expected.quotationId)||
     !/^ANCFZ-[A-Za-z0-9_-]{8,160}$/.test(expected.externalReference)||
     typeof v.orderReference!=="string"||v.orderReference!==expected.orderReference||
     ("providerPaymentId" in expected &&
       v.providerPaymentId!==(expected as PaymentIdentity & {providerPaymentId:string}).providerPaymentId)||
     v.provider!=="2checkout_mock"||v.ticketId!==expected.ticketId||
     v.quotationId!==expected.quotationId||v.externalReference!==expected.externalReference||
     v.amount!==expected.amount||v.currency!==expected.currency)return null;
  const states:Record<string,VerifiedStatus["state"]>={
    COMPLETE:"verified_test_payment",
    PENDING:"payment_pending",
    DECLINED:"payment_declined",
    REFUNDED:"payment_refunded",
  };
  const state=typeof v.providerStatus==="string"?states[v.providerStatus]:undefined;
  if(!state || v.status!==state || v.verified!==(state==="verified_test_payment"))return null;
  return {state,verified:state==="verified_test_payment",providerStatus:v.providerStatus as string};
}
export function otpHmac(pepper:string,challengeId:string,code:string):Buffer {
  return createHmac("sha256",pepper).update(challengeId).update(":").update(code).digest();
}
export function checkOtp(pepper:string,challengeId:string,code:string,digest:string):boolean {
  if(!/^\d{6}$/.test(code)||!/^[a-f0-9]{64}$/.test(digest))return false;
  return timingSafeEqual(otpHmac(pepper,challengeId,code),Buffer.from(digest,"hex"));
}
