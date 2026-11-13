/**
 * P4 private PDF renderer. Receives a PDF only from the fixed n8n webhook;
 * checks ticket/document correlation, PDF bounds and signature before
 * persisting it in ticket-scoped PostgreSQL. No invoices or payment actions.
 */
import { createHash } from "node:crypto";
import { PersistenceDatabase } from "../database/pool.js";
import { appendEventTx } from "../repositories/events.js";
import { quoteDispatchEnabled } from "./quotation-operations.js";

interface Claim {
  agentId:string;ticketId:string;operationId:string;outboxId:string;
  quotationId:string;documentNumber:string;payload:Record<string,unknown>;
}
export interface PdfEvidence {bytes:Buffer;sha256:string}

export function verifyQuotationPdf(raw:unknown,claim:Pick<Claim,"ticketId"|"documentNumber">):PdfEvidence|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const response=raw as Record<string,unknown>;
  if(response.status!=="generated"||response.documentType!=="quotation"||
     response.ticketId!==claim.ticketId||
     response.documentNumber!==claim.documentNumber||
     response.mimeType!=="application/pdf"||
     typeof response.pdfBase64!=="string"||
     response.pdfBase64.length>7_000_000||
     !/^[A-Za-z0-9+/]+={0,2}$/.test(response.pdfBase64))return null;
  const bytes=Buffer.from(response.pdfBase64,"base64");
  if(bytes.length<100||bytes.length>5_242_880||
     bytes.toString("ascii",0,5)!=="%PDF-"||
     !bytes.subarray(Math.max(0,bytes.length-1024)).toString("ascii").includes("%%EOF")||
     bytes.toString("base64")!==response.pdfBase64)return null;
  return {bytes,sha256:createHash("sha256").update(bytes).digest("hex")};
}

async function boundedJson(response:Response):Promise<unknown> {
  if(!response.body)return null;
  const length=Number(response.headers.get("content-length"));
  if(Number.isFinite(length)&&length>7_200_000)return null;
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>7_200_000)return null;
      chunks.push(value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(chunks.map(x=>Buffer.from(x)),size).toString("utf8"));}
  catch{return null;}
}

export class N8nQuoteWorker {
  private timer:ReturnType<typeof setInterval>|undefined;
  private stopped=false;
  private busy=false;
  private lastSweep=0;
  constructor(
    private readonly db:PersistenceDatabase,
    private readonly log:(data:Record<string,unknown>,message:string)=>void,
  ){}

  start():void {
    if(!quoteDispatchEnabled()){
      this.log({enabled:false},"ANCFZ quotation dispatcher disabled");
      return;
    }
    this.timer=setInterval(()=>{void this.tick();},2000);
    this.timer.unref();
    void this.tick();
  }
  stop():void{this.stopped=true;if(this.timer)clearInterval(this.timer);}

  private async agentId():Promise<string|null> {
    const result=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active'",
    );
    return result.rows[0]?.id??null;
  }

  private async quarantineExpired(agentId:string):Promise<void> {
    await this.db.withAgent(agentId,async client=>{
      const expired=await client.query<{id:string;outbox_id:string;ticket_id:string}>(
        `SELECT op.id,op.outbox_id,op.ticket_id
         FROM ticket_operations op
         JOIN event_outbox e ON e.agent_id=op.agent_id AND e.id=op.outbox_id
         WHERE op.agent_id=$1 AND op.operation_key='ancfz_render_quote'
           AND op.state='running' AND e.status='leased' AND e.lease_until<now()
         FOR UPDATE OF op SKIP LOCKED LIMIT 20`,
        [agentId],
      );
      for(const item of expired.rows){
        await client.query(
          "UPDATE ticket_operations SET state='unknown_outcome',provider_status='lease_expired',updated_at=now() WHERE agent_id=$1 AND id=$2",
          [agentId,item.id],
        );
        await client.query(
          "UPDATE event_outbox SET status='dead',lease_until=NULL WHERE agent_id=$1 AND id=$2",
          [agentId,item.outbox_id],
        );
        await appendEventTx(client,agentId,item.ticket_id,"operation.failed",{
          operationId:item.id,operationType:"ancfz_render_quote",reason:"PDF rendering outcome requires review",
        });
      }
    });
  }

  private async claim(agentId:string):Promise<Claim|null> {
    return this.db.withAgent(agentId,async client=>{
      const selected=await client.query<{
        id:string;ticket_id:string;operation_id:string;quotation_id:string;
        document_number:string;payload:Record<string,unknown>;
      }>(
        `SELECT e.id,e.ticket_id,op.id AS operation_id,q.id AS quotation_id,
                q.document_number,e.payload
         FROM event_outbox e
         JOIN ticket_operations op ON op.agent_id=e.agent_id AND op.ticket_id=e.ticket_id
           AND op.outbox_id=e.id AND op.operation_key='ancfz_render_quote'
         JOIN ticket_quotations q ON q.agent_id=op.agent_id AND q.ticket_id=op.ticket_id
           AND q.operation_id=op.id
         JOIN ticket_operations lead ON lead.agent_id=op.agent_id AND lead.ticket_id=op.ticket_id
           AND lead.operation_key='ancfz_salesforce_lead'
           AND lead.state='verified_completed'
           AND lead.provider_reference=q.salesforce_lead_id
         WHERE e.agent_id=$1 AND e.event_type='ancfz_render_quote'
           AND e.status='pending' AND op.state='queued' AND e.available_at<=now()
         ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`,
        [agentId],
      );
      const row=selected.rows[0];
      if(!row)return null;
      await client.query(
        "UPDATE event_outbox SET status='leased',attempts=attempts+1,lease_until=now()+interval '120 seconds' WHERE agent_id=$1 AND id=$2 AND status='pending'",
        [agentId,row.id],
      );
      await client.query(
        "UPDATE ticket_operations SET state='running',updated_at=now() WHERE agent_id=$1 AND id=$2",
        [agentId,row.operation_id],
      );
      await appendEventTx(client,agentId,row.ticket_id,"operation.running",{
        operationId:row.operation_id,quotationId:row.quotation_id,operationType:"ancfz_render_quote",
      });
      return {
        agentId,ticketId:row.ticket_id,operationId:row.operation_id,
        outboxId:row.id,quotationId:row.quotation_id,
        documentNumber:row.document_number,payload:row.payload,
      };
    });
  }

  private async dispatch(claim:Claim):Promise<PdfEvidence|null> {
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(!secret||secret.length<32)return null;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),60000);
    try{
      const response=await fetch("http://n8n:5678/webhook/ancfz/render-pdf",{
        method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify(claim.payload),
      });
      if(!response.ok)return null;
      const parsed=await boundedJson(response);
      return verifyQuotationPdf(parsed,claim);
    }catch{return null;}
    finally{clearTimeout(timeout);}
  }

  private async finalize(claim:Claim,pdf:PdfEvidence|null):Promise<void> {
    await this.db.withAgent(claim.agentId,async client=>{
      const current=await client.query<{state:string}>(
        "SELECT state FROM ticket_operations WHERE agent_id=$1 AND id=$2 FOR UPDATE",
        [claim.agentId,claim.operationId],
      );
      if(current.rows[0]?.state!=="running")return;
      if(pdf){
        await client.query(
          `INSERT INTO ticket_quotation_pdfs(agent_id,ticket_id,quotation_id,bytes,sha256)
           VALUES($1,$2,$3,$4,$5)`,
          [claim.agentId,claim.ticketId,claim.quotationId,pdf.bytes,pdf.sha256],
        );
      }
      await client.query(
        "UPDATE ticket_operations SET state=$3,provider_status=$4,provider_reference=$5,updated_at=now() WHERE agent_id=$1 AND id=$2",
        [claim.agentId,claim.operationId,
          pdf?"verified_completed":"unknown_outcome",
          pdf?"pdf_validated_and_stored":"unverified_pdf_response",
          pdf?claim.documentNumber:null],
      );
      await client.query(
        "UPDATE event_outbox SET status=$3,lease_until=NULL WHERE agent_id=$1 AND id=$2",
        [claim.agentId,claim.outboxId,pdf?"completed":"dead"],
      );
      await appendEventTx(client,claim.agentId,claim.ticketId,
        pdf?"operation.completed":"operation.failed",
        pdf?{
          operationId:claim.operationId,quotationId:claim.quotationId,
          documentNumber:claim.documentNumber,operationType:"ancfz_render_quote",
          verified:true,sha256:pdf.sha256,
        }:{
          operationId:claim.operationId,quotationId:claim.quotationId,
          operationType:"ancfz_render_quote",
          reason:"Quotation PDF not verified; requires reconciliation",
        },
      );
    });
  }

  private async tick():Promise<void> {
    if(this.stopped||this.busy||!quoteDispatchEnabled())return;
    this.busy=true;
    try{
      const agentId=await this.agentId();
      if(!agentId)return;
      if(Date.now()-this.lastSweep>30000){
        await this.quarantineExpired(agentId);
        this.lastSweep=Date.now();
      }
      const claim=await this.claim(agentId);
      if(!claim)return;
      const pdf=await this.dispatch(claim);
      await this.finalize(claim,pdf);
      this.log({
        ticketId:claim.ticketId,quotationId:claim.quotationId,
        status:pdf?"verified_completed":"unknown_outcome",
      },"ANCFZ quotation operation recorded");
    }catch(error){
      this.log({errorCode:(error as Error).name},"ANCFZ quotation dispatch failed; inspect unknown outcome");
    }finally{this.busy=false;}
  }
}
