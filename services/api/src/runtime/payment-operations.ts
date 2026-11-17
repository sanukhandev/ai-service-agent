/**
 * Ticket-owner-authorized ANCFZ POC payment service.
 * Node, never Foundry or n8n, owns consent, challenge HMAC, price snapshot,
 * retry bounds, provider-state verification and the invoice authorization.
 */
import { randomInt, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "../repositories/types.js";
import { appendEventTx } from "../repositories/events.js";
import { lifecycleNoticeId, TicketMessageRepository } from "../repositories/messages.js";
import { createHash } from "node:crypto";
import { PurchaseOperations } from "./purchase-operations.js";
import { assertPurchaseReady } from "./purchase-operations.js";
import { PAYMENT_CONSENT, checkOtp, otpHmac, paymentEnabled,
  verifyPaymentStatus, type PaymentIdentity } from "./payment-evidence.js";

const EMAIL=/^[A-Za-z0-9._%+-]+@example\.invalid$/i;
// OCR accepts international holder names; the sandbox billing preflight must
// not reject the same validated Unicode name solely for being non-ASCII.
const NAME=/^[\p{L}][\p{L}\p{M}\p{N} .'’_-]{0,99}$/u;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type Quote = {id:string;amount:string;currency:string;state:string;has_pdf:boolean};
type OtpRow = {
  id:string;quotation_id:string;request_id:string;otp_hmac:string;state:string;
  failed_attempts:number;expires_at:Date;created_at:Date;amount:string;currency:string;
  email:string;first_name:string;country_code:string;
};
export interface PaymentRow {
  id:string;quotation_id:string;request_id:string;external_reference:string;
  amount:string;currency:string;state:string;order_reference:string|null;
  checkout_url:string|null;provider_status:string|null;verified_at:Date|null;created_at:Date;
}
export function paymentView(p:PaymentRow) {
  return {
    id:p.id,quotationId:p.quotation_id,state:p.state,
    amount:p.amount,currency:p.currency.trim(),orderReference:p.order_reference,
    checkoutUrl:p.checkout_url,providerStatus:p.provider_status,
    verifiedAt:p.verified_at?.toISOString()??null,createdAt:p.created_at.toISOString(),
  };
}
export function parseStartOtp(raw:unknown) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new PersistenceError("INVALID_INPUT","Invalid OTP request");
  const b=raw as Record<string,unknown>;
  const keys=["requestId","quotationId","acceptedAmount","currency","email","firstName","countryCode","consent","consentText"];
  if(Object.keys(b).some(k=>!keys.includes(k))||b.consent!==true||b.consentText!==PAYMENT_CONSENT)
    throw new PersistenceError("INVALID_INPUT","Exact-amount test payment consent required");
  if(typeof b.requestId!=="string"||!uuid.test(b.requestId)||
    typeof b.quotationId!=="string"||!uuid.test(b.quotationId)||
    typeof b.acceptedAmount!=="string"||!/^(?:0|[1-9]\d{0,11})\.\d{2}$/.test(b.acceptedAmount)||
    b.currency!=="AED"||typeof b.email!=="string"||!EMAIL.test(b.email)||
    typeof b.firstName!=="string"||!NAME.test(b.firstName.trim())||
    b.countryCode!=="AE")
    throw new PersistenceError("INVALID_INPUT","Invalid synthetic billing identity or accepted quote");
  return {
    requestId:b.requestId.toLowerCase(),quotationId:b.quotationId.toLowerCase(),
    amount:b.acceptedAmount,currency:"AED",email:b.email.toLowerCase(),
    firstName:b.firstName.trim(),countryCode:"AE",
  };
}
export function parseAuthorize(raw:unknown) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new PersistenceError("INVALID_INPUT","Invalid OTP verification request");
  const b=raw as Record<string,unknown>;
  const fields=["requestId","quotationId","challengeId","code","consent","consentText"];
  if(Object.keys(b).some(k=>!fields.includes(k))||b.consent!==true||b.consentText!==PAYMENT_CONSENT||
    typeof b.requestId!=="string"||!uuid.test(b.requestId)||
    typeof b.quotationId!=="string"||!uuid.test(b.quotationId)||
    typeof b.challengeId!=="string"||!uuid.test(b.challengeId)||
    typeof b.code!=="string"||!/^\d{6}$/.test(b.code))
    throw new PersistenceError("INVALID_INPUT","Invalid test OTP or payment authorization");
  return {
    requestId:b.requestId.toLowerCase(),quotationId:b.quotationId.toLowerCase(),
    challengeId:b.challengeId.toLowerCase(),code:b.code,
  };
}
async function requireAncfz(client:PoolClient,agentId:string):Promise<void>{
  const r=await client.query<{id:string}>(
    "SELECT id FROM agents WHERE id=$1 AND agent_key='ancfz' AND status='active'",[agentId]);
  if(!r.rows[0])throw new PersistenceError("NOT_FOUND","ANCFZ payment operation unavailable");
}
async function quote(client:PoolClient,agentId:string,ticketId:string,quotationId:string):Promise<Quote>{
  // The parent ticket is already locked by the caller and verified quotations
  // are immutable to agent_runtime (SELECT/INSERT only). FOR UPDATE OF q
  // would require UPDATE privilege and fail with SQLSTATE 42501.
  const result=await client.query<Quote>(
    `SELECT q.id,q.amount::text,q.currency,op.state,
        EXISTS(SELECT 1 FROM ticket_quotation_pdfs pdf
          WHERE pdf.agent_id=q.agent_id AND pdf.ticket_id=q.ticket_id
            AND pdf.quotation_id=q.id) AS has_pdf
      FROM ticket_quotations q
      JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.ticket_id=q.ticket_id
        AND op.id=q.operation_id AND op.operation_key='ancfz_render_quote'
      WHERE q.agent_id=$1 AND q.ticket_id=$2 AND q.id=$3`,
    [agentId,ticketId,quotationId],
  );
  const q=result.rows[0];
  if(!q||q.state!=="verified_completed"||!q.has_pdf)
    throw new PersistenceError("CONFLICT","Verified quotation PDF is required before payment");
  return q;
}
async function requestJson(path:string,payload:Record<string,unknown>,limit:number=8192):Promise<unknown>{
  const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
  if(!secret||secret.length<32)throw new Error("Private n8n dispatch is unavailable");
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),20000);
  try {
    const response=await fetch("http://n8n:5678/webhook/"+path,{
      method:"POST",redirect:"error",signal:ctrl.signal,
      headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
      body:JSON.stringify(payload),
    });
    if(!response.ok)throw new Error("Private n8n workflow rejected request");
    const length=Number(response.headers.get("content-length"));
    if(Number.isFinite(length)&&length>limit)throw new Error("Oversized n8n response");
    const text=await response.text();
    if(text.length>limit)throw new Error("Oversized n8n response");
    return JSON.parse(text) as unknown;
  }finally{clearTimeout(timer);}
}
/**
 * A temporary GET outage is not an authoritative reversal of a previously
 * COMPLETE order. Once REFUNDED is independently observed, a stale COMPLETE
 * response must not re-activate the invoice.
 */
export function reconcileGatewayCheck(
  previousState:string,previousProviderStatus:string|null,
  checked:ReturnType<typeof verifyPaymentStatus>,
):{state:string;providerStatus:string}{
  if(previousState==="payment_refunded"||previousProviderStatus==="REFUNDED")
    return {state:"payment_refunded",providerStatus:"REFUNDED"};
  if(checked?.state==="payment_refunded")
    return {state:"payment_refunded",providerStatus:"REFUNDED"};
  if(previousState==="verified_test_payment"||previousProviderStatus==="COMPLETE")
    return {state:"verified_test_payment",providerStatus:"COMPLETE"};
  return checked ? {state:checked.state,providerStatus:checked.providerStatus}
    : {state:"unknown_outcome",providerStatus:"verification_failed"};
}
export class PaymentOperations {
  constructor(private readonly db:PersistenceDatabase){}
  private requireEnabled():void {
    if(!paymentEnabled())throw new PersistenceError("NOT_CONFIGURED","Development sandbox payments are disabled");
  }
  async issueOtp(scope:TicketScope,ticketId:string,raw:unknown){
    this.requireEnabled();
    requireUuid(ticketId,"ticketId");
    const input=parseStartOtp(raw);
    const pepper=process.env.ANCFZ_OTP_PEPPER as string;
    const otp=String(randomInt(0,1000000)).padStart(6,"0");
    const challengeId=randomUUID();
    const created=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      await requireAncfz(client,scope.agentId);
      const q=await quote(client,scope.agentId,ticketId,input.quotationId);
      await assertPurchaseReady(client,scope.agentId,ticketId,input.quotationId);
      if(q.amount!==input.amount||q.currency.trim()!==input.currency)
        throw new PersistenceError("CONFLICT","Price or currency changed; request a fresh quote");
      const count=await client.query<{count:string;last:Date|null}>(
        `SELECT count(*)::text AS count,max(created_at) AS last
          FROM ticket_payment_otps
          WHERE agent_id=$1 AND ticket_id=$2 AND created_at>now()-interval '1 hour'`,
        [scope.agentId,ticketId]);
      const last=count.rows[0]?.last;
      if(Number(count.rows[0]?.count??0)>=5 ||
        (last && Date.now()-last.getTime()<60000))
        throw new PersistenceError("CONFLICT","OTP request rate limit; retry after cooldown");
      await client.query(
        `UPDATE ticket_payment_otps SET state='expired'
          WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3
            AND state IN ('pending','mock_recorded')`,
        [scope.agentId,ticketId,input.quotationId]);
      const existing=await client.query<OtpRow>(
        `SELECT * FROM ticket_payment_otps
          WHERE agent_id=$1 AND ticket_id=$2 AND request_id=$3`,
        [scope.agentId,ticketId,input.requestId]);
      if(existing.rows[0])throw new PersistenceError("CONFLICT","OTP request already used");
      const expires=new Date(Date.now()+300000);
      await client.query(
        `INSERT INTO ticket_payment_otps
          (id,agent_id,ticket_id,quotation_id,request_id,email,first_name,
           country_code,amount,currency,otp_hmac,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [challengeId,scope.agentId,ticketId,input.quotationId,input.requestId,
          input.email,input.firstName,input.countryCode,input.amount,input.currency,
          otpHmac(pepper,challengeId,otp).toString("hex"),expires],
      );
      await appendEventTx(client,scope.agentId,ticketId,"payment.otp_requested",{
        challengeId,quotationId:input.quotationId,expiresAt:expires.toISOString(),
      });
      return {challengeId,expiresAt:expires.toISOString()};
    });
    let recorded=false;
    try{
      const answer=await requestJson("ancfz/otp-email",{
        agentKey:"ancfz",ticketId,email:input.email,otp,
        testOnly:true,deliveryMode:"mock_datatable",
      },4096) as Record<string,unknown>;
      recorded=answer?.status==="mock_recorded" && answer?.testOnly===true &&
        answer?.delivered===false;
    }catch{/* never print OTP or webhook payload */}
    await this.db.withAgent(scope.agentId,async client=>{
      await client.query(
        `UPDATE ticket_payment_otps SET state=$4
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND state='pending'`,
        [scope.agentId,ticketId,challengeId,recorded?"mock_recorded":"failed"]);
    });
    if(!recorded)throw new PersistenceError("CONFLICT","Test OTP could not be recorded. No payment is authorized");
    return {challengeId,quotationId:input.quotationId,expiresAt:created.expiresAt,
      status:"mock_recorded",delivery:"n8n_test_table_only",realDelivery:false};
  }
  async authorize(scope:TicketScope,ticketId:string,raw:unknown){
    this.requireEnabled();
    requireUuid(ticketId,"ticketId");
    const input=parseAuthorize(raw),pepper=process.env.ANCFZ_OTP_PEPPER as string;
    const attemptId=randomUUID(),externalReference="ANCFZ-"+attemptId.replace(/-/g,"");
    const outcome=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      await requireAncfz(client,scope.agentId);
      const q=await quote(client,scope.agentId,ticketId,input.quotationId);
      await assertPurchaseReady(client,scope.agentId,ticketId,input.quotationId);
      const dup=await client.query<PaymentRow>(
        `SELECT id,quotation_id,request_id,external_reference,amount::text,currency,state,
          order_reference,checkout_url,provider_status,verified_at,created_at
          FROM ticket_payment_attempts
          WHERE agent_id=$1 AND ticket_id=$2 AND request_id=$3`,
        [scope.agentId,ticketId,input.requestId]);
      if(dup.rows[0]){
        if(dup.rows[0].quotation_id!==input.quotationId)
          throw new PersistenceError("CONFLICT","Idempotency request references another quotation");
        return {payment:paymentView(dup.rows[0]),badCode:false};
      }
      const challenge=await client.query<OtpRow>(
        `SELECT id,quotation_id,request_id,otp_hmac,state,failed_attempts,expires_at,
          created_at,amount::text,currency,email,first_name,country_code
          FROM ticket_payment_otps
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 FOR UPDATE`,
        [scope.agentId,ticketId,input.challengeId]);
      const row=challenge.rows[0];
      if(!row||row.quotation_id!==input.quotationId ||
         row.state!=="mock_recorded" || row.expires_at.getTime()<=Date.now() ||
         row.failed_attempts>=5)
        throw new PersistenceError("CONFLICT","OTP expired, consumed or unavailable");
      if(!checkOtp(pepper,row.id,input.code,row.otp_hmac)){
        await client.query(
          `UPDATE ticket_payment_otps
            SET failed_attempts=failed_attempts+1,
                state=CASE WHEN failed_attempts>=4 THEN 'failed' ELSE state END
            WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,
          [scope.agentId,ticketId,row.id],
        );
        return {payment:null,badCode:true};
      }
      if(row.amount!==q.amount||row.currency.trim()!==q.currency.trim())
        throw new PersistenceError("CONFLICT","Quotation changed after OTP issuance");
      const other=await client.query<{id:string}>(
        `SELECT id FROM ticket_payment_attempts
          WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3`,
        [scope.agentId,ticketId,input.quotationId]);
      if(other.rows.length)throw new PersistenceError("CONFLICT","A payment order already exists for this quote");
      const event=await client.query<{id:string}>(
        `INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,idempotency_key)
          VALUES($1,$2,'ancfz_2checkout_create',$3::jsonb,$4) RETURNING id`,
        [scope.agentId,ticketId,JSON.stringify({paymentId:attemptId}),
          "2checkout-create:"+input.quotationId],
      );
      const outbox=event.rows[0]?.id;
      if(!outbox)throw new PersistenceError("DATABASE_ERROR","Payment outbox unavailable");
      const paid=await client.query<PaymentRow>(
        `INSERT INTO ticket_payment_attempts
          (id,agent_id,ticket_id,quotation_id,otp_id,request_id,outbox_id,
           external_reference,amount,currency,first_name,email,country_code)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          RETURNING id,quotation_id,request_id,external_reference,amount::text,
            currency,state,order_reference,checkout_url,provider_status,verified_at,created_at`,
        [attemptId,scope.agentId,ticketId,input.quotationId,row.id,input.requestId,outbox,
          externalReference,q.amount,q.currency.trim(),row.first_name,row.email,row.country_code.trim()],
      );
      await client.query(
        `UPDATE ticket_payment_otps SET state='consumed',consumed_at=now()
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,
        [scope.agentId,ticketId,row.id]);
      await appendEventTx(client,scope.agentId,ticketId,"payment.queued",{
        paymentId:attemptId,quotationId:input.quotationId,
      });
      // OTP verification, payment queue and assistant message commit atomically.
      await new TicketMessageRepository(this.db).tryAssistantLifecycleNoticeTx(
        client,scope,ticketId,lifecycleNoticeId("otp.verified",row.id),
        "Your synthetic test OTP has been verified. Your sandbox order is queued; payment has not yet been confirmed.",
      );
      return {payment:paymentView(paid.rows[0]),badCode:false};
    });
    if(outcome.badCode)throw new PersistenceError("INVALID_INPUT","Invalid test OTP");
    return {payment:outcome.payment};
  }
  async get(scope:TicketScope,ticketId:string){
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      await requireAncfz(client,scope.agentId);
      const rows=await client.query<PaymentRow>(
        `SELECT id,quotation_id,request_id,external_reference,amount::text,currency,
          state,order_reference,checkout_url,provider_status,verified_at,created_at
          FROM ticket_payment_attempts WHERE agent_id=$1 AND ticket_id=$2
          ORDER BY created_at DESC LIMIT 10`,
        [scope.agentId,ticketId]);
      const invoice=await client.query<{
        id:string;payment_id:string;state:string;document_number:string;payment_state:string;
      }>(`SELECT i.id,i.payment_id,i.state,i.document_number,p.state AS payment_state
             FROM ticket_payment_invoices i
             JOIN ticket_payment_attempts p ON p.agent_id=i.agent_id AND p.ticket_id=i.ticket_id
               AND p.id=i.payment_id
             WHERE i.agent_id=$1 AND i.ticket_id=$2 LIMIT 1`,[scope.agentId,ticketId]);
      return {enabled:paymentEnabled(),payments:rows.rows.map(paymentView),
        invoice:invoice.rows[0] ? {
          id:invoice.rows[0].id,paymentId:invoice.rows[0].payment_id,
          state:invoice.rows[0].state,documentNumber:invoice.rows[0].document_number,
          pdfAvailable:invoice.rows[0].state==="verified_completed" && invoice.rows[0].payment_state==="verified_test_payment",
        }:null};
    });
  }
  async verify(scope:TicketScope,ticketId:string,paymentId:string){
    this.requireEnabled();requireUuid(ticketId,"ticketId");requireUuid(paymentId,"paymentId");
    const claim=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      await requireAncfz(client,scope.agentId);
      const selected=await client.query<{
        id:string;quotation_id:string;external_reference:string;amount:string;
        currency:string;state:string;order_reference:string|null;verification_started_at:Date|null;
        provider_status:string|null;
      }>(
        `SELECT id,quotation_id,external_reference,amount::text,currency,state,order_reference,
          verification_started_at,provider_status FROM ticket_payment_attempts
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 FOR UPDATE`,
        [scope.agentId,ticketId,paymentId],
      );
      const p=selected.rows[0];
      if(!p)throw new PersistenceError("NOT_FOUND","Payment not found");
      // A fresh GET can detect a later refund even after a prior COMPLETE.
      if(!p.order_reference||!["checkout_available","order_created_checkout_unavailable",
         "payment_pending","payment_declined","payment_refunded","unknown_outcome",
         "verifying","verified_test_payment"].includes(p.state))
        throw new PersistenceError("CONFLICT","Payment order is not ready for independent verification");
      if(p.state==="verifying" && p.verification_started_at &&
         Date.now()-p.verification_started_at.getTime()<120000)
        throw new PersistenceError("CONFLICT","Payment verification already in progress");
      await client.query(
        `UPDATE ticket_payment_attempts
          SET state='verifying',verification_started_at=now(),updated_at=now()
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,
        [scope.agentId,ticketId,paymentId]);
      await appendEventTx(client,scope.agentId,ticketId,"payment.verification.started",{
        paymentId,testOnly:true,
      });
      const ticket=await client.query<{status:string}>(
        "SELECT status FROM tickets WHERE agent_id=$1 AND id=$2",
        [scope.agentId,ticketId],
      );
      const agent=await client.query<{status:string}>(
        "SELECT status FROM agents WHERE id=$1",[scope.agentId],
      );
      if(ticket.rows[0]?.status!=="closed" && agent.rows[0]?.status==="active") {
        await new TicketMessageRepository(this.db).tryAssistantLifecycleNoticeTx(
          client,scope,ticketId,lifecycleNoticeId("payment.verification.started",paymentId),
          "Your sandbox payment verification has started. You can continue chatting while the provider status is checked.",
        );
      }
      return {
        expected:{
          ticketId,quotationId:p.quotation_id,externalReference:p.external_reference,
          amount:p.amount,currency:p.currency.trim(),orderReference:p.order_reference,
        },
        previousState:p.state,previousProviderStatus:p.provider_status,
      };
    });
    const expected=claim.expected as PaymentIdentity & {orderReference:string};
    let result:ReturnType<typeof verifyPaymentStatus>=null;
    try {
      const response=await requestJson("ancfz/payment-verify",{agentKey:"ancfz",...expected});
      result=verifyPaymentStatus(response,expected);
    } catch {/* missing/ambiguous provider evidence must never become paid */}
    const finalState=await this.db.withAgent(scope.agentId,async client=>{
      const selected=await client.query<{state:string}>(
        `SELECT state FROM ticket_payment_attempts
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 FOR UPDATE`,
        [scope.agentId,ticketId,paymentId]);
      if(selected.rows[0]?.state!=="verifying")return null;
      const resolved=reconcileGatewayCheck(claim.previousState,claim.previousProviderStatus,result);
      const newState=resolved.state;
      await client.query(
        `UPDATE ticket_payment_attempts SET state=$4,provider_status=$5,
          verified_at=CASE WHEN $4='verified_test_payment' THEN COALESCE(verified_at,now()) ELSE verified_at END,
          verification_started_at=NULL,
          verification_attempts=LEAST(verification_attempts+1,60),
          next_verification_at=CASE
             WHEN $4='verified_test_payment' THEN now()+interval '10 minutes'
             ELSE now()+interval '30 seconds' END,updated_at=now()
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,
        [scope.agentId,ticketId,paymentId,newState,resolved.providerStatus],
      );
      if(newState==="verified_test_payment"){
        const existingInvoice=await client.query<{id:string}>(
          "SELECT id FROM ticket_payment_invoices WHERE agent_id=$1 AND ticket_id=$2 AND payment_id=$3",
          [scope.agentId,ticketId,paymentId],
        );
        if(!existingInvoice.rows.length){
        const invoiceId=randomUUID();
        const docNumber="ANCFZ-TEST-INV-"+invoiceId;
        const queued=await client.query<{id:string}>(
          `INSERT INTO event_outbox(agent_id,ticket_id,event_type,payload,idempotency_key)
            VALUES($1,$2,'ancfz_render_invoice',$3::jsonb,$4) RETURNING id`,
          [scope.agentId,ticketId,JSON.stringify({paymentId}),
            "2checkout-invoice:"+paymentId],
        );
        await client.query(
          `INSERT INTO ticket_payment_invoices
            (id,agent_id,ticket_id,quotation_id,payment_id,outbox_id,document_number)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [invoiceId,scope.agentId,ticketId,expected.quotationId,paymentId,
            queued.rows[0]?.id,docNumber],
        );
        }
        if(claim.previousState!=="verified_test_payment") {
          await appendEventTx(client,scope.agentId,ticketId,"payment.verified",{
            paymentId,quotationId:expected.quotationId,testOnly:true,
          });
        }
        // A customer may close the ticket while the provider GET is in flight.
        // That must not roll back a verified payment or leave it stuck verifying.
        const activeTicket=await client.query<{status:string}>(
          "SELECT status FROM tickets WHERE agent_id=$1 AND id=$2",
          [scope.agentId,ticketId],
        );
        const activeAgent=await client.query<{status:string}>(
          "SELECT status FROM agents WHERE id=$1",[scope.agentId],
        );
        if(activeTicket.rows[0]?.status!=="closed" && activeAgent.rows[0]?.status==="active") {
          await new TicketMessageRepository(this.db).tryAssistantLifecycleNoticeTx(
            client,scope,ticketId,lifecycleNoticeId("payment.verified",paymentId),
            "Your sandbox payment has been independently verified as COMPLETE. I am preparing your TEST invoice now.",
          );
        }
      }else{
        await appendEventTx(client,scope.agentId,ticketId,"payment.checked",{
          paymentId,providerStatus:result?.providerStatus??"unavailable",verified:false,
        });
      }
      return newState;
    });
    if(finalState==="payment_declined"||finalState==="payment_refunded"){
      // This is a durable assistant ticket message, not a gateway success claim.
      // A repeated GET for the same terminal state cannot spam the transcript.
      const brand=await new PurchaseOperations(this.db).read(scope,ticketId);
      const name=brand.persona.name;
      const formal=brand.persona.tone==="formal";
      const copy=finalState==="payment_declined"
        ? (formal
          ? "The gateway has declined the test payment. The quotation remains available; no paid invoice has been issued. Please contact the service team to review the next available options."
          : "The test payment was declined by the gateway. Your quotation is still available, and no invoice has been issued. I can help you review the next steps.")
        : (formal
          ? "The gateway now reports this test payment as refunded. The TEST invoice download is no longer available. Please contact the service team for assistance."
          : "The gateway reports that your test payment was refunded. I've disabled access to the earlier TEST invoice; I can help you with the next steps.");
      const digest=createHash("sha256").update(paymentId+":"+finalState).digest("hex");
      const noticeId=digest.slice(0,8)+"-"+digest.slice(8,12)+"-4"+digest.slice(13,16)+
        "-8"+digest.slice(17,20)+"-"+digest.slice(20,32);
      try{
        await new TicketMessageRepository(this.db).createAssistantMessage(
          scope,ticketId,noticeId,name+": "+copy,[]);
      }catch{/* Payment evidence remains authoritative even if message delivery fails. */}
    }
    return this.get(scope,ticketId);
  }
  async invoicePdf(scope:TicketScope,ticketId:string,invoiceId:string){
    requireUuid(ticketId,"ticketId");requireUuid(invoiceId,"invoiceId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      await requireAncfz(client,scope.agentId);
      const result=await client.query<{bytes:Buffer;document_number:string}>(
        `SELECT i.bytes,i.document_number FROM ticket_payment_invoices i
          JOIN ticket_payment_attempts p ON p.agent_id=i.agent_id AND p.ticket_id=i.ticket_id
            AND p.id=i.payment_id AND p.state='verified_test_payment'
          WHERE i.agent_id=$1 AND i.ticket_id=$2 AND i.id=$3
            AND i.state='verified_completed' AND i.bytes IS NOT NULL`,
        [scope.agentId,ticketId,invoiceId]);
      const row=result.rows[0];
      if(!row)throw new PersistenceError("NOT_FOUND","Test invoice is not available");
      return {bytes:row.bytes,documentNumber:row.document_number};
    });
  }
}
