/**
 * Test invoice renderer: only claims a durable, independently verified
 * 2Checkout sandbox payment, never an n8n/user-supplied 'paid' flag.
 */
import { PersistenceDatabase } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { workerTicketScope } from "../repositories/types.js";
import { paymentEnabled } from "./payment-evidence.js";
import { boundedJson, verifyInvoicePdf } from "./n8n-quote-worker.js";
interface Claim {
  agentId:string;ticketId:string;quotationId:string;paymentId:string;
  invoiceId:string;outboxId:string;documentNumber:string;
  orderReference:string;customerName:string;offeringLabel:string;
  amount:string;currency:string;
}
export class N8nInvoiceWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private stopped=false;
  private busy=false;
  private lastSweep=0;
  constructor(
    private readonly db:PersistenceDatabase,
    private readonly log:(data:Record<string,unknown>,message:string)=>void,
  ){}
  start():void{
    if(!paymentEnabled()){this.log({enabled:false},"ANCFZ sandbox invoice worker disabled");return;}
    this.timer=setInterval(()=>{void this.tick();},2000);this.timer.unref();void this.tick();
  }
  stop():void{this.stopped=true;if(this.timer)clearInterval(this.timer);}
  private async agentId(){
    const r=await this.db.pool.query<{id:string}>("SELECT id FROM agents WHERE agent_key='ancfz' AND status='active'");
    return r.rows[0]?.id??null;
  }
  private async quarantine(agentId:string){
    await this.db.withAgent(agentId,async client=>{
      const r=await client.query<{id:string;outbox_id:string;ticket_id:string}>(
        `SELECT i.id,i.outbox_id,i.ticket_id FROM ticket_payment_invoices i
          JOIN event_outbox e ON e.agent_id=i.agent_id AND e.ticket_id=i.ticket_id
            AND e.id=i.outbox_id
          WHERE i.agent_id=$1 AND i.state='running' AND e.status='leased'
            AND e.lease_until<now()
          FOR UPDATE OF i,e SKIP LOCKED LIMIT 20`,
        [agentId],
      );
      for(const item of r.rows){
        await client.query(
          "UPDATE ticket_payment_invoices SET state='unknown_outcome',updated_at=now() WHERE agent_id=$1 AND id=$2",
          [agentId,item.id],
        );
        await client.query(
          "UPDATE event_outbox SET status='dead',lease_until=NULL WHERE agent_id=$1 AND id=$2",
          [agentId,item.outbox_id],
        );
        await appendEventTx(client,agentId,item.ticket_id,"invoice.unknown_outcome",{invoiceId:item.id});
      }
    });
  }
  private async claim(agentId:string):Promise<Claim|null>{
    return this.db.withAgent(agentId,async client=>{
      const r=await client.query<{
        id:string;ticket_id:string;quotation_id:string;payment_id:string;outbox_id:string;
        document_number:string;order_reference:string;customer_name:string;
        offering_label:string;amount:string;currency:string;
      }>(
        `SELECT i.id,i.ticket_id,i.quotation_id,i.payment_id,i.outbox_id,i.document_number,
          p.order_reference,q.customer_name,q.offering_label,q.amount::text,q.currency
          FROM ticket_payment_invoices i
          JOIN event_outbox e ON e.agent_id=i.agent_id AND e.ticket_id=i.ticket_id
            AND e.id=i.outbox_id
          JOIN ticket_payment_attempts p ON p.agent_id=i.agent_id AND p.ticket_id=i.ticket_id
            AND p.id=i.payment_id AND p.quotation_id=i.quotation_id
            AND p.state='verified_test_payment' AND p.order_reference IS NOT NULL
            AND p.amount=(SELECT q2.amount FROM ticket_quotations q2
              WHERE q2.agent_id=i.agent_id AND q2.ticket_id=i.ticket_id AND q2.id=i.quotation_id)
          JOIN ticket_quotations q ON q.agent_id=i.agent_id AND q.ticket_id=i.ticket_id
            AND q.id=i.quotation_id AND q.currency=p.currency
          WHERE i.agent_id=$1 AND i.state='queued' AND e.event_type='ancfz_render_invoice'
            AND e.status='pending' AND e.available_at<=now()
          ORDER BY e.created_at FOR UPDATE OF i,e SKIP LOCKED LIMIT 1`,
        [agentId],
      );
      const x=r.rows[0];if(!x)return null;
      await client.query(
        "UPDATE event_outbox SET status='leased',attempts=attempts+1,lease_until=now()+interval '90 seconds' WHERE agent_id=$1 AND id=$2",
        [agentId,x.outbox_id],
      );
      await client.query(
        "UPDATE ticket_payment_invoices SET state='running',updated_at=now() WHERE agent_id=$1 AND id=$2",
        [agentId,x.id],
      );
      await appendEventTx(client,agentId,x.ticket_id,"invoice.rendering",{invoiceId:x.id,paymentId:x.payment_id});
      return {
        agentId,ticketId:x.ticket_id,quotationId:x.quotation_id,paymentId:x.payment_id,
        invoiceId:x.id,outboxId:x.outbox_id,documentNumber:x.document_number,
        orderReference:x.order_reference,customerName:x.customer_name,
        offeringLabel:x.offering_label,amount:x.amount,currency:x.currency.trim(),
      };
    });
  }
  private async dispatch(c:Claim):Promise<ReturnType<typeof verifyInvoicePdf>> {
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(!secret||secret.length<32)return null;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);
    try {
      const total=Number(c.amount);
      if(!Number.isFinite(total)||total<=0)return null;
      const response=await fetch("http://n8n:5678/webhook/ancfz/render-pdf",{
        method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify({
          agentKey:"ancfz",ticketId:c.ticketId,quotationId:c.quotationId,
          documentType:"invoice",documentNumber:c.documentNumber,
          customerName:c.customerName,currency:c.currency,
          lines:[{label:c.offeringLabel,amount:total}],total,
          paymentVerified:true,
          paymentEvidence:{
            status:"verified_test_payment",provider:"2checkout_mock",
            providerReference:c.orderReference,ticketId:c.ticketId,
            quotationId:c.quotationId,amount:c.amount,currency:c.currency,
          },
        }),
      });
      if(!response.ok)return null;
      const result=await boundedJson(response);
      return verifyInvoicePdf(result,c);
    }catch{return null;}finally{clearTimeout(timer);}
  }
  private async finalize(c:Claim,pdf:ReturnType<typeof verifyInvoicePdf>):Promise<boolean>{
    return this.db.withAgent(c.agentId,async client=>{
      const check=await client.query<{state:string}>(
        "SELECT state FROM ticket_payment_invoices WHERE agent_id=$1 AND id=$2 FOR UPDATE",
        [c.agentId,c.invoiceId],
      );
      if(check.rows[0]?.state!=="running")return false;
      const pay=await client.query<{state:string}>(
        "SELECT state FROM ticket_payment_attempts WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 FOR UPDATE",
        [c.agentId,c.ticketId,c.paymentId],
      );
      // Reject concurrent refunds before committing PDF bytes or a chat link.
      const publish=Boolean(pdf)&&pay.rows[0]?.state==="verified_test_payment";
      await client.query(
        `UPDATE ticket_payment_invoices SET state=$3,bytes=$4,sha256=$5,updated_at=now()
          WHERE agent_id=$1 AND id=$2`,
        [c.agentId,c.invoiceId,publish?"verified_completed":"unknown_outcome",
          publish?pdf?.bytes??null:null,publish?pdf?.sha256??null:null],
      );
      await client.query(
        "UPDATE event_outbox SET status=$3,lease_until=NULL WHERE agent_id=$1 AND id=$2",
        [c.agentId,c.outboxId,publish?"completed":"dead"],
      );
      await appendEventTx(client,c.agentId,c.ticketId,
        publish?"invoice.generated":"invoice.unknown_outcome",{
          invoiceId:c.invoiceId,paymentId:c.paymentId,testOnly:true,
          pdfVerified:publish,
        });
      return publish;
    });
  }
  private async tick(){
    if(this.stopped||this.busy||!paymentEnabled())return;
    this.busy=true;
    try{
      const agent=await this.agentId();if(!agent)return;
      if(Date.now()-this.lastSweep>30000){await this.quarantine(agent);this.lastSweep=Date.now();}
      const claim=await this.claim(agent);if(!claim)return;
      const pdf=await this.dispatch(claim);
      const published=await this.finalize(claim,pdf);
      if(published){
        // Download is authorized by the existing ticket-owned invoice PDF route.
        // Stable request ID prevents duplicate assistant messages on retries.
        const link="/api/v1/tickets/"+claim.ticketId+"/invoices/"+claim.invoiceId+"/pdf";
        try {
          await new TicketMessageRepository(this.db).createAssistantMessage(
            workerTicketScope(claim.agentId,claim.ticketId),claim.ticketId,claim.invoiceId,
            "Your sandbox payment has been independently verified and your TEST invoice is ready. "+
            "[Download your TEST invoice]("+link+").",[]);
        }catch {
          this.log({invoiceId:claim.invoiceId},"Invoice PDF saved but chat notification was unavailable");
        }
      }
      this.log({invoiceId:claim.invoiceId,status:published?"verified_completed":"unknown_outcome"},
        "ANCFZ TEST invoice recorded");
    }catch(e){
      this.log({errorCode:(e as Error).name},"ANCFZ invoice worker failed");
    }finally{this.busy=false;}
  }
}
