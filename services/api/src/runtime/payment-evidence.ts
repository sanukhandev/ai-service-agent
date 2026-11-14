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
  orderReference:string; checkoutUrl:string|null;
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
export function isCheckoutUrl(value:unknown):value is string {
  if(typeof value!=="string"||value.length>2048)return false;
  try {
    const u=new URL(value);
    return u.protocol==="https:" && u.hostname==="mockgateway.com" &&
      u.pathname.startsWith("/pg/pay/") && !u.username && !u.password && !u.hash;
  } catch {return false;}
}
export function verifyCreatedOrder(raw:unknown,expected:PaymentIdentity):CreatedOrder|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  if(v.provider!=="2checkout_mock"||v.verified!==false||
     v.ticketId!==expected.ticketId||v.quotationId!==expected.quotationId||
     v.externalReference!==expected.externalReference||v.amount!==expected.amount||
     v.currency!==expected.currency||typeof v.orderReference!=="string"||
     !ref.test(v.orderReference))return null;
  if(v.status==="checkout_available" && isCheckoutUrl(v.checkoutUrl))
    return {state:"checkout_available",orderReference:v.orderReference,checkoutUrl:v.checkoutUrl};
  if(v.status==="order_created_checkout_unavailable" && v.checkoutUrl===null)
    return {state:"order_created_checkout_unavailable",orderReference:v.orderReference,checkoutUrl:null};
  return null;
}
export function verifyPaymentStatus(raw:unknown,expected:PaymentIdentity & {orderReference:string}):VerifiedStatus|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  if(!uuid.test(expected.ticketId)||!uuid.test(expected.quotationId)||
     !/^ANCFZ-[A-Za-z0-9_-]{8,160}$/.test(expected.externalReference)||
     typeof v.orderReference!=="string"||v.orderReference!==expected.orderReference||
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
