/**
 * Test invoice renderer: only claims a durable, independently verified
 * 2Checkout sandbox payment, never an n8n/user-supplied 'paid' flag.
 */
import { createHash } from "node:crypto";
import { PersistenceDatabase } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { TicketMessageRepository } from "../repositories/messages.js";
import { workerTicketScope } from "../repositories/types.js";
import { paymentEnabled } from "./payment-evidence.js";
import { boundedJson, verifyInvoicePdf } from "./n8n-quote-worker.js";
import { invoiceBillingName } from "./purchase-operations.js";
import { extractInvoiceEmiratesId, nameKey } from "./identity-extractor.js";
import { invoiceQuoteDetails } from "./invoice-details.js";
import type { QuoteProposalDetails } from "./quote-proposal.js";
interface Claim {
  agentId:string;ticketId:string;quotationId:string;paymentId:string;
  invoiceId:string;outboxId:string;documentNumber:string;
  orderReference:string;customerName:string;offeringLabel:string;
  amount:string;currency:string;proposal:QuoteProposalDetails|null;
  emiratesDocument:Buffer;emiratesLast4:string;emiratesName:string;
}
/**
 * A GET verification in flight is not a refunded or failed payment. Defer
 * invoice finalization until the independent provider check settles.
 */
export function invoiceFinalizationDecision(
  paymentState:string|null,hasValidPdf:boolean,
):"verified_completed"|"deferred"|"unknown_outcome" {
  if(paymentState==="verifying")return "deferred";
  return paymentState==="verified_test_payment"&&hasValidPdf
    ?"verified_completed":"unknown_outcome";
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
        quote_document_number:string;quote_payload:unknown;
      }>(
        `SELECT i.id,i.ticket_id,i.quotation_id,i.payment_id,i.outbox_id,i.document_number,
          p.order_reference,q.customer_name,q.offering_label,q.amount::text,q.currency,
          q.document_number AS quote_document_number, qe.payload AS quote_payload
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
          LEFT JOIN ticket_operations qo ON qo.agent_id=q.agent_id AND qo.ticket_id=q.ticket_id
            AND qo.id=q.operation_id AND qo.operation_key='ancfz_render_quote'
          LEFT JOIN event_outbox qe ON qe.agent_id=qo.agent_id AND qe.ticket_id=qo.ticket_id
            AND qe.id=qo.outbox_id AND qe.event_type='ancfz_render_quote'
          WHERE i.agent_id=$1 AND i.state='queued' AND e.event_type='ancfz_render_invoice'
            AND e.status='pending' AND e.available_at<=now()
          ORDER BY e.created_at FOR UPDATE OF i,e SKIP LOCKED LIMIT 1`,
        [agentId],
      );
      const x=r.rows[0];if(!x)return null;
      const doc=await client.query<{
        bytes:Buffer;sha256:string;extracted_full_name:string;
        document_number_last4:string|null;
      }>(
        `SELECT d.bytes,d.sha256,d.extracted_full_name,d.document_number_last4
          FROM ticket_purchase_documents d
          JOIN intent_document_requirements req
            ON req.agent_id=d.agent_id AND req.intent_id=d.intent_id
            AND req.id=d.requirement_id AND req.requirement_key='emirates_id'
          JOIN ticket_purchase_confirmations pc
            ON pc.agent_id=d.agent_id AND pc.ticket_id=d.ticket_id
            AND pc.intent_id=d.intent_id AND pc.quotation_id=$3
          WHERE d.agent_id=$1 AND d.ticket_id=$2
            AND d.state='received' AND d.extraction_status='extracted'
            AND d.extracted_full_name IS NOT NULL
            AND d.document_number_last4 IS NOT NULL LIMIT 1`,
        [agentId,x.ticket_id,x.quotation_id],
      );
      const idDoc=doc.rows[0];
      if(!idDoc || !/^[0-9]{4}$/.test(idDoc.document_number_last4?.trim()??"") ||
         createHash("sha256").update(idDoc.bytes).digest("hex")!==idDoc.sha256)
        throw new Error("Verified invoice identity document unavailable");
      const proposal=invoiceQuoteDetails(x.quote_payload,{
        quotationDocumentNumber:x.quote_document_number,
        amount:x.amount,currency:x.currency.trim(),
      });
      await client.query(
        "UPDATE event_outbox SET status='leased',attempts=attempts+1,lease_until=now()+interval '180 seconds' WHERE agent_id=$1 AND id=$2",
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
        orderReference:x.order_reference,
        customerName:await invoiceBillingName(client,agentId,x.ticket_id,x.quotation_id),
        offeringLabel:x.offering_label,amount:x.amount,currency:x.currency.trim(),
        proposal,emiratesDocument:idDoc.bytes,
        emiratesLast4:idDoc.document_number_last4!.trim(),
        emiratesName:idDoc.extracted_full_name,
      };
    });
  }
  private async dispatch(c:Claim):Promise<ReturnType<typeof verifyInvoicePdf>> {
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(!secret||secret.length<32)return null;
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),135000);
    try {
      const total=Number(c.amount);
      if(!Number.isFinite(total)||total<=0)return null;
      // OCR remains in Node: n8n receives only the document number needed
      // for this protected TEST PDF, never the underlying ID file or raw OCR.
      // If re-extraction fails, render only the already recorded last four
      // digits rather than inventing a full number or losing a paid invoice.
      let emiratesIdNumber:string|null=null;
      try{
        const extracted=await extractInvoiceEmiratesId(c.emiratesDocument);
        if(extracted.last4===c.emiratesLast4 &&
           nameKey(extracted.fullName)===nameKey(c.emiratesName))
          emiratesIdNumber=extracted.number;
      }catch{/* A private OCR failure must not cancel a verified paid invoice. */}
      const response=await fetch("http://n8n:5678/webhook/ancfz/render-pdf",{
        method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify({
          agentKey:"ancfz",ticketId:c.ticketId,quotationId:c.quotationId,
          documentType:"invoice",documentNumber:c.documentNumber,
          customerName:c.customerName,currency:c.currency,
          lines:[{label:c.offeringLabel,amount:total}],total,
          proposal:c.proposal,
          invoiceIdentity:{emiratesIdNumber,emiratesIdLast4:c.emiratesLast4},
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
  private async finalize(c:Claim,pdf:ReturnType<typeof verifyInvoicePdf>):Promise<"verified_completed"|"deferred"|"unknown_outcome">{
    return this.db.withAgent(c.agentId,async client=>{
      const check=await client.query<{state:string}>(
        "SELECT state FROM ticket_payment_invoices WHERE agent_id=$1 AND id=$2 FOR UPDATE",
        [c.agentId,c.invoiceId],
      );
      if(check.rows[0]?.state!=="running")return "unknown_outcome";
      const pay=await client.query<{state:string}>(
        "SELECT state FROM ticket_payment_attempts WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 FOR UPDATE",
        [c.agentId,c.ticketId,c.paymentId],
      );
      // A read-only gateway GET temporarily puts the payment into "verifying".
      // Retain the invoice as queued instead of permanently dropping the PDF
      // while that check is in progress. The next claim re-renders the same
      // TEST invoice reference only if payment is independently confirmed.
      // The claim requires payment.state='verified_test_payment', so no timer
      // backoff or event_outbox.available_at privilege change is needed.
      const decision=invoiceFinalizationDecision(pay.rows[0]?.state??null,Boolean(pdf));
      if(decision==="deferred"){
        await client.query(
          "UPDATE ticket_payment_invoices SET state='queued',updated_at=now() WHERE agent_id=$1 AND id=$2",
          [c.agentId,c.invoiceId],
        );
        await client.query(
          `UPDATE event_outbox
             SET status='pending',lease_until=NULL
           WHERE agent_id=$1 AND id=$2`,
          [c.agentId,c.outboxId],
        );
        await appendEventTx(client,c.agentId,c.ticketId,"invoice.deferred",{
          invoiceId:c.invoiceId,paymentId:c.paymentId,reason:"payment_verification_in_progress",
        });
        return "deferred";
      }
      // Reject a verified refund (and any other non-paid state) before
      // committing PDF bytes or exposing a chat download link.
      const publish=decision==="verified_completed";
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
      return decision;
    });
  }
  private async notifyInvoice(
    claim:Pick<Claim,"agentId"|"ticketId"|"invoiceId">,
  ):Promise<void>{
    const link="/api/v1/tickets/"+claim.ticketId+"/invoices/"+claim.invoiceId+"/pdf";
    await new TicketMessageRepository(this.db).createAssistantMessage(
      workerTicketScope(claim.agentId,claim.ticketId),claim.ticketId,claim.invoiceId,
      "Your sandbox payment has been independently verified and your TEST invoice is ready. "+
      "[Download your TEST invoice]("+link+").",[],
    );
  }

  /**
   * Persisted PDF and the chat message are deliberately separate operations.
   * If the process dies between the two, reconcile the missing message
   * without regenerating the PDF or submitting a second payment.
   */
  private async recoverInvoiceNotification(agentId:string):Promise<void>{
    const pending=await this.db.withAgent(agentId,async client=>{
      const r=await client.query<{id:string;ticket_id:string}>(
        `SELECT i.id,i.ticket_id FROM ticket_payment_invoices i
         JOIN ticket_payment_attempts p ON p.agent_id=i.agent_id AND p.ticket_id=i.ticket_id
           AND p.id=i.payment_id AND p.state='verified_test_payment'
         JOIN tickets t ON t.agent_id=i.agent_id AND t.id=i.ticket_id
           AND t.status<>'closed'
         WHERE i.agent_id=$1 AND i.state='verified_completed' AND i.bytes IS NOT NULL
           AND NOT EXISTS(
             SELECT 1 FROM ticket_messages m
             WHERE m.agent_id=i.agent_id AND m.ticket_id=i.ticket_id
               AND m.role='assistant' AND m.request_id=i.id
           )
         ORDER BY i.created_at LIMIT 1`,[agentId],
      );
      return r.rows[0]??null;
    });
    if(pending){
      await this.notifyInvoice({agentId,ticketId:pending.ticket_id,invoiceId:pending.id});
      this.log({invoiceId:pending.id},"Recovered missing TEST invoice chat link");
    }
  }

  private async tick(){
    if(this.stopped||this.busy||!paymentEnabled())return;
    this.busy=true;
    try{
      const agent=await this.agentId();if(!agent)return;
      if(Date.now()-this.lastSweep>30000){
        await this.quarantine(agent);
        try{
          await this.recoverInvoiceNotification(agent);
        }catch{
          // A chat-notification outage must never stop independent invoice
          // rendering for a different customer ticket.
          this.log({agentId:agent},"Invoice chat recovery will retry");
        }
        this.lastSweep=Date.now();
      }
      const claim=await this.claim(agent);if(!claim)return;
      const pdf=await this.dispatch(claim);
      const finalized=await this.finalize(claim,pdf);
      if(finalized==="verified_completed"){
        try{
          await this.notifyInvoice(claim);
        }catch{
          this.log({invoiceId:claim.invoiceId},
            "Invoice PDF saved; durable chat-link recovery will retry");
        }
      }
      this.log({invoiceId:claim.invoiceId,status:finalized},
        "ANCFZ TEST invoice recorded");
    }catch(e){
      this.log({errorCode:(e as Error).name},"ANCFZ invoice worker failed");
    }finally{this.busy=false;}
  }
}
