/**
 * One-shot 2Checkout sandbox order dispatcher.
 * Each authorized payment gets one POST. Ambiguous outcomes are quarantined,
 * never blindly retried; a provider order is not a verified payment.
 */
import { PersistenceDatabase } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { lifecycleNoticeId, TicketMessageRepository } from "../repositories/messages.js";
import { workerTicketScope } from "../repositories/types.js";
import { paymentEnabled, inspectCreatedOrder, type PaymentIdentity,
  type CreatedOrder } from "./payment-evidence.js";

interface Claim extends PaymentIdentity {
  agentId:string;outboxId:string;paymentId:string;
  firstName:string;email:string;countryCode:string;
}
interface DispatchResult {created:CreatedOrder|null;reason:string}
export class N8nPaymentWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private stopped=false;
  private busy=false;
  private lastSweep=0;
  constructor(
    private readonly db:PersistenceDatabase,
    private readonly log:(data:Record<string,unknown>,message:string)=>void,
  ){}
  start():void {
    if(!paymentEnabled()){
      this.log({enabled:false},"ANCFZ 2Checkout sandbox dispatcher disabled");
      return;
    }
    this.timer=setInterval(()=>{void this.tick();},2000);this.timer.unref();void this.tick();
  }
  stop():void {this.stopped=true;if(this.timer)clearInterval(this.timer);}
  private async agentId():Promise<string|null> {
    const r=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active'",
    );
    return r.rows[0]?.id??null;
  }
  private async quarantine(agentId:string):Promise<void> {
    await this.db.withAgent(agentId,async client=>{
      const r=await client.query<{outbox_id:string;payment_id:string;ticket_id:string}>(
        `SELECT e.id AS outbox_id,p.id AS payment_id,e.ticket_id
        FROM event_outbox e
        JOIN ticket_payment_attempts p ON p.agent_id=e.agent_id AND p.ticket_id=e.ticket_id
          AND p.outbox_id=e.id
        WHERE e.agent_id=$1 AND e.event_type='ancfz_2checkout_create'
          AND e.status='leased' AND e.lease_until<now() AND p.state='creating'
        FOR UPDATE OF e,p SKIP LOCKED LIMIT 20`,
        [agentId],
      );
      for(const item of r.rows){
        await client.query(
          "UPDATE ticket_payment_attempts SET state='unknown_outcome',provider_status='post_lease_expired',updated_at=now() WHERE agent_id=$1 AND id=$2",
          [agentId,item.payment_id],
        );
        await client.query(
          "UPDATE event_outbox SET status='dead',lease_until=NULL WHERE agent_id=$1 AND id=$2",
          [agentId,item.outbox_id],
        );
        await appendEventTx(client,agentId,item.ticket_id,"payment.unknown_outcome",{
          paymentId:item.payment_id,reason:"Order POST outcome unknown; do not retry blindly",
        });
      }
    });
  }
  private async claim(agentId:string):Promise<Claim|null> {
    return this.db.withAgent(agentId,async client=>{
      const r=await client.query<{
        outbox_id:string;payment_id:string;ticket_id:string;quotation_id:string;
        external_reference:string;amount:string;currency:string;
        first_name:string;email:string;country_code:string;
      }>(
        `SELECT e.id AS outbox_id,p.id AS payment_id,e.ticket_id,p.quotation_id,
            p.external_reference,p.amount::text,p.currency,p.first_name,p.email,p.country_code
          FROM event_outbox e
          JOIN ticket_payment_attempts p ON p.agent_id=e.agent_id AND p.ticket_id=e.ticket_id
            AND p.outbox_id=e.id
          JOIN ticket_quotations q ON q.agent_id=p.agent_id AND q.ticket_id=p.ticket_id
            AND q.id=p.quotation_id AND q.amount=p.amount AND q.currency=p.currency
          JOIN ticket_operations op ON op.agent_id=q.agent_id AND op.ticket_id=q.ticket_id
            AND op.id=q.operation_id AND op.state='verified_completed'
          WHERE e.agent_id=$1 AND e.event_type='ancfz_2checkout_create' AND e.status='pending'
            AND e.available_at<=now() AND p.state='queued'
          ORDER BY e.created_at FOR UPDATE OF e,p SKIP LOCKED LIMIT 1`,
        [agentId],
      );
      const x=r.rows[0];if(!x)return null;
      await client.query(
        "UPDATE event_outbox SET status='leased',attempts=attempts+1,lease_until=now()+interval '90 seconds' WHERE agent_id=$1 AND id=$2",
        [agentId,x.outbox_id],
      );
      await client.query(
        "UPDATE ticket_payment_attempts SET state='creating',updated_at=now() WHERE agent_id=$1 AND id=$2",
        [agentId,x.payment_id],
      );
      await appendEventTx(client,agentId,x.ticket_id,"payment.creating",{paymentId:x.payment_id});
      return {
        agentId,ticketId:x.ticket_id,quotationId:x.quotation_id,paymentId:x.payment_id,
        outboxId:x.outbox_id,externalReference:x.external_reference,
        amount:x.amount,currency:x.currency.trim(),firstName:x.first_name,
        email:x.email,countryCode:x.country_code.trim(),
      };
    });
  }
  private async send(c:Claim):Promise<DispatchResult>{
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(!secret||secret.length<32)return {created:null,reason:"n8n_secret_missing"};
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);
    try{
      const response=await fetch("http://n8n:5678/webhook/ancfz/payment-link",{
        method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify({
          agentKey:"ancfz",ticketId:c.ticketId,quotationId:c.quotationId,
          externalReference:c.externalReference,currency:c.currency,amount:c.amount,
          firstName:c.firstName,email:c.email,countryCode:c.countryCode,
          otpVerified:true,customerConsent:true,
        }),
      });
      // HTTP status is non-sensitive; never log the response body or headers.
      if(!response.ok)return {created:null,reason:"n8n_http_"+response.status};
      const length=Number(response.headers.get("content-length"));
      if(Number.isFinite(length)&&length>8192)
        return {created:null,reason:"n8n_response_oversize"};
      const body=await response.text();
      if(body.length>8192)return {created:null,reason:"n8n_response_oversize"};
      let raw:unknown;
      try{raw=JSON.parse(body);}catch{
        return {created:null,reason:"n8n_response_not_json"};
      }
      return inspectCreatedOrder(raw,c);
    }catch(err){
      return {created:null,reason:err instanceof Error&&err.name==="AbortError"
        ?"n8n_timeout":"n8n_network_or_redirect_error"};
    }finally{clearTimeout(timer);}
  }
  private async finalize(c:Claim,result:DispatchResult){
    const created=result.created;
    await this.db.withAgent(c.agentId,async client=>{
      const r=await client.query<{state:string}>(
        "SELECT state FROM ticket_payment_attempts WHERE agent_id=$1 AND id=$2 FOR UPDATE",
        [c.agentId,c.paymentId],
      );
      if(r.rows[0]?.state!=="creating")return;
      await client.query(
        `UPDATE ticket_payment_attempts SET state=$3,order_reference=$4,
          checkout_url=$5,provider_status=$6,updated_at=now()
          WHERE agent_id=$1 AND id=$2`,
        [c.agentId,c.paymentId,
          created?.state??"unknown_outcome",created?.orderReference??null,
          created?.checkoutUrl??null,
          created?"order_created_not_paid":result.reason],
      );
      await client.query(
        "UPDATE event_outbox SET status=$3,lease_until=NULL WHERE agent_id=$1 AND id=$2",
        [c.agentId,c.outboxId,created?"completed":"dead"],
      );
      await appendEventTx(client,c.agentId,c.ticketId,
        created?"payment.order_created":"payment.unknown_outcome",{
          paymentId:c.paymentId,quotationId:c.quotationId,
          status:created?.state??"unknown_outcome",
          verified:false,...(created?{}:{reason:result.reason}),
        });
      if(created?.checkoutUrl){
        // A checkout link is NOT evidence of payment. Payment verification
        // remains an independent authenticated provider GET.
        await new TicketMessageRepository(this.db).tryAssistantLifecycleNoticeTx(
          client,workerTicketScope(c.agentId,c.ticketId),c.ticketId,
          lifecycleNoticeId("checkout.available",c.paymentId),
          "Your test payment order is ready. [Open the hosted sandbox checkout]("+
          created.checkoutUrl+"). Do not enter card information into chat. "+
          "I will issue a TEST invoice only after independent payment verification.",
        );
      }
    });
  }
  private async tick(){
    if(this.stopped||this.busy||!paymentEnabled())return;
    this.busy=true;
    try{
      const id=await this.agentId();if(!id)return;
      if(Date.now()-this.lastSweep>30000){
        await this.quarantine(id);this.lastSweep=Date.now();
      }
      const claim=await this.claim(id);if(!claim)return;
      const result=await this.send(claim);
      await this.finalize(claim,result);
      this.log({paymentId:claim.paymentId,
        status:result.created?.state??"unknown_outcome",
        outcomeCode:result.reason},
        "ANCFZ sandbox order attempt recorded");
    }catch(e){
      this.log({errorCode:(e as Error).name},"2Checkout worker failed; reconcile unknown state");
    }finally{this.busy=false;}
  }
}
