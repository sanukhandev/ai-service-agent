/**
 * ANCFZ sandbox service contract.
 * A read-only PDF derivation of the exact paid quotation, plus privately held
 * passport and Emirates ID annexures. Never produces a legal e-signature.
 * No AI, browser, public URL or n8n receives identity document bytes.
 */
import {createHash,randomUUID} from "node:crypto";
import {PersistenceDatabase} from "../database/pool.js";
import {appendEventTx} from "../repositories/events.js";
import {TicketMessageRepository} from "../repositories/messages.js";
import {workerTicketScope} from "../repositories/types.js";
import {paymentEnabled} from "./payment-evidence.js";
import {PURCHASE_CONSENT} from "./purchase-operations.js";
import {allowUnnamedSyntheticPassport} from "./identity-extractor.js";
import {extractInvoiceEmiratesId,nameKey} from "./identity-extractor.js";
import {invoiceQuoteDetails} from "./invoice-details.js";
import type {QuoteProposalDetails} from "./quote-proposal.js";

type IdentityFile={
  kind:"passport"|"emirates_id";name:string;contentType:string;
  bytes:Buffer;sha256:string;extractedName:string|null;last4:string|null;
  extractionStatus:"extracted"|"pending";extractionModel:string|null;
};
type Claim={
  id:string;agentId:string;ticketId:string;quotationId:string;
  paymentId:string;documentNumber:string;contractNumber:string;
  agreementRevision:number;invoiceNumber:string;offering:string;
  amount:string;currency:string;quoteNumber:string;quotePayload:unknown;
  documents:IdentityFile[];
};
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const escaped=(value:string)=>value.replace(/[&<>"']/g,ch=>({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
})[ch]??ch);
const short=(value:string,max=3000)=>escaped(value.slice(0,max));
function validPdf(bytes:Buffer):boolean{
  return bytes.length>=100 && bytes.length<=15728640 &&
    bytes.toString("ascii",0,5)==="%PDF-" &&
    bytes.subarray(Math.max(0,bytes.length-1024)).toString("ascii").includes("%%EOF");
}
/** Match the same explicit sandbox passport exception already authorized by
 * the purchase preflight. The Emirates ID must still be OCR-extracted and its
 * name and last four verified; never accept a contradictory passport name.
 */
export function validateContractDocuments(
  files:IdentityFile[],permitUnnamedSyntheticPassport=allowUnnamedSyntheticPassport(),
):void{
  if(files.length!==2||!files.some(f=>f.kind==="passport")||
     !files.some(f=>f.kind==="emirates_id"))
    throw new Error("required_private_documents_missing");
  for(const f of files){
    const synthetic=f.kind==="passport"&&permitUnnamedSyntheticPassport&&
      f.extractionStatus==="pending"&&f.extractionModel==="prebuilt-idDocument"&&
      f.extractedName===null;
    if((!f.extractedName&&!synthetic)||
       (f.extractedName!==null&&f.extractionStatus!=="extracted")||
       f.bytes.length<100||f.bytes.length>1048576||
       sha(f.bytes)!==f.sha256||
       !["application/pdf","image/png","image/jpeg"].includes(f.contentType)||
       (f.contentType==="application/pdf"&&!validPdf(f.bytes)))
      throw new Error("private_document_evidence_mismatch");
  }
  const passport=files.find(f=>f.kind==="passport")!;
  const emirates=files.find(f=>f.kind==="emirates_id")!;
  if(!emirates.extractedName||emirates.extractionStatus!=="extracted"||
     !emirates.last4||!/^\\d{4}$/.test(emirates.last4))
    throw new Error("verified_emirates_last4_missing");
  if(passport.extractedName&&
     nameKey(passport.extractedName)!==nameKey(emirates.extractedName))
    throw new Error("identity_names_do_not_match");
}
async function gotenberg(path:string,files:Array<{name:string;type:string;bytes:Buffer}>):Promise<Buffer>{
  const form=new FormData();
  for(const f of files){
    form.append("files",new Blob([new Uint8Array(f.bytes)],{type:f.type}),f.name);
  }
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),65000);
  try{
    const r=await fetch("http://gotenberg:3000"+path,{
      method:"POST",redirect:"error",body:form,signal:controller.signal,
    });
    const advertised=Number(r.headers.get("content-length")??"0");
    if(!r.ok||advertised>15728640)
      throw new Error("internal_pdf_renderer_unavailable");
    const data=Buffer.from(await r.arrayBuffer());
    if(!validPdf(data))throw new Error("invalid_generated_pdf");
    return data;
  }finally{clearTimeout(timeout);}
}
async function htmlPdf(html:string):Promise<Buffer>{
  return gotenberg("/forms/chromium/convert/html",[
    {name:"index.html",type:"text/html",bytes:Buffer.from(html,"utf8")},
  ]);
}
function page(content:string):string{
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+
    'body{font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#193044;margin:32px}'+
    'h1{font-size:24px;color:#164d78}h2{font-size:17px;margin-top:26px;border-bottom:1px solid #ddd}'+
    'table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #ddd;text-align:left;padding:8px}'+
    'img{max-width:100%;max-height:88vh;object-fit:contain}.stamp{border:2px dashed #777;padding:12px;display:inline-block}'+
    '.warning{font-weight:bold;color:#9c2828}.fine{font-size:10px;color:#666}'+
    '</style></head><body>'+content+'</body></html>';
}
function contractHtml(c:Claim,proposal:QuoteProposalDetails,id:{name:string;number:string}):string{
  // Extract only explicit "Includes ..." items from the frozen quotation.
  // Price tiers, exclusions and preferences are not secretly converted into
  // billable or promised services. Retain the complete original scope below.
  const description=proposal.packageDescription.trim();
  const included=description.match(/(?:^|[.;]\s*)Includes\s+([^;.]+)/i)?.[1]??"";
  const items=included
    ?included.split(/,\s*|\s+and\s+/i).map(v=>v.trim()).filter(Boolean)
    :description.split(/\n+/).map(v=>v.replace(/^\s*[-*•]\s*/,"").trim()).filter(Boolean);
  const requirements=proposal.requirements.map(r=>
    "<tr><td>"+short(r.label,140)+"</td><td>"+short(r.value,400)+"</td></tr>").join("");
  const now=new Date().toISOString().slice(0,10);
  return page(
    '<p class="warning">DEMONSTRATION ONLY — NOT A LEGALLY EXECUTED AGREEMENT</p>'+
    "<h1>ANCFZ — Service Contract (TEST)</h1>"+
    "<p>Contract number: <strong>"+short(c.contractNumber,40)+"</strong> | Revision: "+
    String(c.agreementRevision)+" | Prepared: "+now+"</p>"+
    "<p>Quotation number: "+short(c.quoteNumber,100)+" | Invoice number: "+
    short(c.invoiceNumber,100)+"</p>"+
    "<h2>1. Parties and identification</h2>"+
    "<p>Provider: ANCFZ (sandbox demonstration). Customer: "+short(id.name,150)+
    ". Emirates ID: "+short(id.number,20)+".</p>"+
    "<p>Identity references are based on the uploaded customer documents and OCR, not government authenticity verification.</p>"+
    "<h2>2. Purchased package</h2>"+
    "<table><tr><th>Package</th><th>Amount</th></tr><tr><td>"+
    short(c.offering,200)+"</td><td>"+short(c.currency,3)+" "+short(c.amount,20)+"</td></tr></table>"+
    "<p>Approved quotation: "+short(c.quoteNumber,100)+
    ". Matching paid invoice: "+short(c.invoiceNumber,100)+
    ". The quotation's published scope and pricing revision govern this draft.</p>"+
    "<h2>3. Services included in the purchased package</h2>"+
    "<ol>"+items.map(v=>"<li>"+short(v)+"</li>").join("")+"</ol>"+
    "<h3>Complete approved package description</h3><p>"+short(description)+"</p>"+
    "<p>These inclusions are extracted solely from the purchased quotation. No additional"+
    " visa, workspace, licence, third-party charge or approval is implied.</p>"+
    "<h2>4. Customer requirements recorded with the quotation</h2>"+
    (requirements?"<table><tr><th>Requirement</th><th>Requested selection</th></tr>"+
      requirements+"</table>":"<p>No additional itemized customer requirements.</p>")+
    "<p>Requested preferences are not included services unless expressly confirmed in Section 3.</p>"+
    "<h2>5. Charges and commercial conditions</h2>"+
    "<p>Quoted sandbox total: "+short(c.currency,3)+" "+short(c.amount,20)+
    ". This document records an independently verified TEST payment only, not real funds.</p>"+
    "<p>"+short(proposal.priceConditions||
      "No additional price conditions were attached to the published quotation.")+"</p>"+
    "<h2>6. Performance, approvals and exclusions</h2>"+
    "<p>This document is a POC sample and does not itself begin performance or issue"+
    " any licence, visa or government permit. Any real service schedule, authority"+
    " charges, acceptance criteria, refund terms, regulatory approvals and cancellations"+
    " require a separately approved and executed agreement.</p>"+
    "<h2>7. Documents and confidentiality</h2>"+
    "<p>Annex A contains the uploaded passport copy. Annex B contains the uploaded Emirates"+
    " ID copy. Both are private customer submissions. Access is restricted to the"+
    " authenticated ticket owner; do not distribute this contract publicly.</p>"+
    "<h2>8. First-party electronic signature (DEMO)</h2>"+
    '<div class="stamp"><strong>ANCFZ — FIRST PARTY</strong><p>/s/ ANCFZ Authorized Representative</p>'+
    '<p>DEMO / NOT CRYPTOGRAPHICALLY SIGNED / NOT LEGALLY EXECUTED</p></div>'+
    "<p>Customer signature: Not collected. This document is not an executed bilateral contract.</p>"+
    '<p class="fine">Created solely for ANCFZ sandbox workflow demonstration. No real payment or legal service undertaking is evidenced.</p>'
  );
}
async function annexPdf(file:IdentityFile):Promise<Buffer>{
  if(file.contentType==="application/pdf")return file.bytes;
  const src="data:"+file.contentType+";base64,"+file.bytes.toString("base64");
  return htmlPdf(page("<h1>"+(file.kind==="passport"?"Annex A — Passport copy":
    "Annex B — Emirates ID copy")+"</h1><img alt=\"Private identity document\" src=\""+src+"\"/>"));
}

export class ServiceContractWorker{
  private timer:ReturnType<typeof setInterval>|undefined;
  private busy=false;
  private stopped=false;
  constructor(private readonly db:PersistenceDatabase,
    private readonly log:(data:Record<string,unknown>,message:string)=>void){}
  start():void{
    if(!paymentEnabled())return;
    this.timer=setInterval(()=>{void this.tick();},4000);
    this.timer.unref();void this.tick();
  }
  stop():void{this.stopped=true;if(this.timer)clearInterval(this.timer);}
  private async agentId():Promise<string|null>{
    const r=await this.db.pool.query<{id:string}>(
      "SELECT id FROM agents WHERE agent_key='ancfz' AND status='active'");
    return r.rows[0]?.id??null;
  }
  /**
   * Crash-safe backfill for an invoice that finished after payment verification
   * but has no contract row. Only exact customer approval for the protected
   * private agreement can create the row. Never creates an order or invoice.
   */
  private async recoverMissingContract(agentId:string):Promise<void>{
    await this.db.withAgent(agentId,async client=>{
      const r=await client.query<{
        ticket_id:string;quotation_id:string;payment_id:string;
      }>(
        `SELECT p.ticket_id,p.quotation_id,p.id AS payment_id
         FROM ticket_payment_attempts p
         JOIN ticket_payment_invoices i ON i.agent_id=p.agent_id
           AND i.ticket_id=p.ticket_id AND i.payment_id=p.id
           AND i.state='verified_completed' AND i.bytes IS NOT NULL
         JOIN ticket_purchase_confirmations pc ON pc.agent_id=p.agent_id
           AND pc.ticket_id=p.ticket_id AND pc.quotation_id=p.quotation_id
           AND pc.consent_text=$2
         WHERE p.agent_id=$1 AND p.state='verified_test_payment'
           AND NOT EXISTS (
             SELECT 1 FROM ticket_service_contracts c WHERE c.agent_id=p.agent_id
               AND c.ticket_id=p.ticket_id AND c.payment_id=p.id
           )
         ORDER BY p.created_at LIMIT 1`,[agentId,PURCHASE_CONSENT]);
      const x=r.rows[0];if(!x)return;
      const id=randomUUID();
      const inserted=await client.query(
        `INSERT INTO ticket_service_contracts
           (id,agent_id,ticket_id,quotation_id,payment_id,document_number)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(agent_id,ticket_id,payment_id) DO NOTHING
         RETURNING id`,
        [id,agentId,x.ticket_id,x.quotation_id,x.payment_id,
          "ANCFZ-TEST-SC-"+id]);
      if(inserted.rows.length){
        await appendEventTx(client,agentId,x.ticket_id,
          "contract.queued_recovered",{contractId:id,paymentId:x.payment_id,testOnly:true});
      }
    });
  }
  /**
   * Only one additional recovery attempt for pre-diagnostic stuck agreements.
   * This does not touch paid status, quotes, invoices, consents or PDF bytes.
   * Persisting the sentinel before queueing makes the recovery one-shot across
   * restarts; subsequent failures retain a concrete failure_code.
   */
  private async recoverUndiagnosedContract(agentId:string):Promise<void>{
    await this.db.withAgent(agentId,async client=>{
      const updated=await client.query<{id:string;ticket_id:string}>(
        `UPDATE ticket_service_contracts SET
           state='queued',render_attempts=0,
           failure_code='legacy_retry_queued',updated_at=now()
         WHERE agent_id=$1 AND id=(
           SELECT c.id FROM ticket_service_contracts c
           JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id
             AND p.ticket_id=c.ticket_id AND p.id=c.payment_id
             AND p.state='verified_test_payment'
           JOIN ticket_payment_invoices i ON i.agent_id=c.agent_id
             AND i.ticket_id=c.ticket_id AND i.payment_id=c.payment_id
             AND i.state='verified_completed' AND i.bytes IS NOT NULL
           JOIN ticket_purchase_confirmations pc ON pc.agent_id=c.agent_id
             AND pc.ticket_id=c.ticket_id AND pc.quotation_id=c.quotation_id
             AND pc.consent_text=$2
           WHERE c.agent_id=$1 AND c.state='needs_review'
             AND c.render_attempts=3 AND c.failure_code IS NULL
             AND c.bytes IS NULL
           ORDER BY c.created_at,c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1
         ) RETURNING id,ticket_id`,[agentId,PURCHASE_CONSENT]);
      const row=updated.rows[0];if(!row)return;
      await appendEventTx(client,agentId,row.ticket_id,
        "contract.legacy_retry_queued",{contractId:row.id,testOnly:true});
    });
  }
  private async claim(agentId:string):Promise<Claim|null>{
    return this.db.withAgent(agentId,async client=>{
      await client.query(
        "UPDATE ticket_service_contracts SET state=CASE WHEN render_attempts>=3 "+
        "THEN 'needs_review' ELSE 'queued' END,updated_at=now() "+
        "WHERE agent_id=$1 AND state='running' AND updated_at<now()-interval '5 minutes'",
        [agentId]);
      const r=await client.query<{
        id:string;ticket_id:string;quotation_id:string;payment_id:string;
        document_number:string;contract_number:string;agreement_revision:number;
        invoice_document_number:string;offering_label:string;amount:string;
        currency:string;quote_document_number:string;quote_payload:unknown;
      }>(
        "SELECT c.id,c.ticket_id,c.quotation_id,c.payment_id,c.document_number,"+
        "c.contract_number,c.agreement_revision,"+
        "i.document_number AS invoice_document_number,"+
        "q.offering_label,q.amount::text AS amount,q.currency,"+
        "q.document_number AS quote_document_number,qe.payload AS quote_payload "+
        "FROM ticket_service_contracts c "+
        "JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id AND p.ticket_id=c.ticket_id "+
        "AND p.id=c.payment_id AND p.quotation_id=c.quotation_id "+
        "AND p.state='verified_test_payment' "+
        "JOIN ticket_payment_invoices i ON i.agent_id=c.agent_id "+
        "AND i.ticket_id=c.ticket_id AND i.payment_id=c.payment_id "+
        "AND i.quotation_id=c.quotation_id AND i.state='verified_completed' "+
        "AND i.bytes IS NOT NULL "+
        "JOIN ticket_quotations q ON q.agent_id=c.agent_id AND q.ticket_id=c.ticket_id "+
        "AND q.id=c.quotation_id AND q.amount=p.amount AND q.currency=p.currency "+
        "LEFT JOIN ticket_operations qo ON qo.agent_id=q.agent_id AND qo.ticket_id=q.ticket_id "+
        "AND qo.id=q.operation_id AND qo.operation_key='ancfz_render_quote' "+
        "LEFT JOIN event_outbox qe ON qe.agent_id=qo.agent_id AND qe.ticket_id=qo.ticket_id "+
        "AND qe.id=qo.outbox_id AND qe.event_type='ancfz_render_quote' "+
        "WHERE c.agent_id=$1 AND c.state='queued' AND c.render_attempts<3 "+
        "ORDER BY c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1",
        [agentId]);
      const x=r.rows[0];if(!x)return null;
      const docs=await client.query<{
        requirement_key:"passport"|"emirates_id";file_name:string;content_type:string;
        bytes:Buffer;sha256:string;extracted_full_name:string|null;
        document_number_last4:string|null;
        extraction_status:"extracted"|"pending";extraction_model:string|null;
      }>(
        "SELECT req.requirement_key,d.file_name,d.content_type,d.bytes,d.sha256,"+
        "d.extracted_full_name,d.document_number_last4,"+
        "d.extraction_status,d.extraction_model "+
        "FROM ticket_purchase_documents d "+
        "JOIN intent_document_requirements req ON req.agent_id=d.agent_id "+
        "AND req.intent_id=d.intent_id AND req.id=d.requirement_id "+
        "JOIN ticket_purchase_confirmations pc ON pc.agent_id=d.agent_id "+
        "AND pc.ticket_id=d.ticket_id AND pc.intent_id=d.intent_id "+
        "AND pc.quotation_id=$3 "+
        "WHERE d.agent_id=$1 AND d.ticket_id=$2 AND d.state='received' "+
        "AND (d.extraction_status='extracted' OR "+
        "(req.requirement_key='passport' AND $4::boolean "+
        "AND d.extraction_status='pending' "+
        "AND d.extraction_model='prebuilt-idDocument' "+
        "AND d.extracted_full_name IS NULL)) "+
        "AND req.requirement_key IN ('passport','emirates_id') "+
        "AND pc.consent_text=$5",
        [agentId,x.ticket_id,x.quotation_id,allowUnnamedSyntheticPassport(),PURCHASE_CONSENT]);
      await client.query(
        "UPDATE ticket_service_contracts SET state='running',render_attempts=render_attempts+1,"+
        "updated_at=now() WHERE agent_id=$1 AND id=$2",
        [agentId,x.id]);
      return {
        id:x.id,agentId,ticketId:x.ticket_id,quotationId:x.quotation_id,
        paymentId:x.payment_id,documentNumber:x.document_number,
        contractNumber:x.contract_number,agreementRevision:x.agreement_revision,
        invoiceNumber:x.invoice_document_number,
        offering:x.offering_label,amount:x.amount,currency:x.currency.trim(),
        quoteNumber:x.quote_document_number,quotePayload:x.quote_payload,
        documents:docs.rows.map(d=>({
          kind:d.requirement_key,name:d.file_name,contentType:d.content_type,
          bytes:d.bytes,sha256:d.sha256,extractedName:d.extracted_full_name,
          last4:d.document_number_last4,
          extractionStatus:d.extraction_status,extractionModel:d.extraction_model,
        })),
      };
    });
  }
  private async render(c:Claim):Promise<Buffer>{
    validateContractDocuments(c.documents);
    const emirates=c.documents.find(f=>f.kind==="emirates_id")!;
    // Do not fail an independently verified invoice for transient repeat OCR.
    // The previously verified last four is displayed masked on a retry.
    if(!emirates.last4||!/^\d{4}$/.test(emirates.last4))
      throw new Error("verified_emirates_last4_missing");
    let displayId="XXXX-XXXX-XXXX-"+emirates.last4;
    let displayName=emirates.extractedName;
    try{
      const extracted=await extractInvoiceEmiratesId(emirates.bytes);
      if(extracted.last4!==emirates.last4||
         nameKey(extracted.fullName)!==nameKey(emirates.extractedName))
        throw new Error("emirates_id_ocr_mismatch");
      displayId=extracted.number;
      displayName=extracted.fullName;
    }catch(e){
      if((e as Error).message==="emirates_id_ocr_mismatch")throw e;
      // Neither the full number nor a fabricated substitute is stored.
    }
    const proposal=invoiceQuoteDetails(c.quotePayload,{
      quotationDocumentNumber:c.quoteNumber,amount:c.amount,currency:c.currency,
    });
    if(!proposal||!proposal.packageDescription.trim())
      throw new Error("approved_package_scope_missing");
    const contract=await htmlPdf(contractHtml(c,proposal,{
      name:displayName,number:displayId,
    }));
    const passport=c.documents.find(f=>f.kind==="passport")!;
    const parts=[contract,await annexPdf(passport),await annexPdf(emirates)];
    return gotenberg("/forms/pdfengines/merge",parts.map((bytes,i)=>({
      name:String(i+1).padStart(2,"0")+".pdf",type:"application/pdf",bytes,
    })));
  }
  private async notify(c:Pick<Claim,"id"|"agentId"|"ticketId"|"contractNumber">):Promise<void>{
    const link="/api/v1/tickets/"+c.ticketId+"/contracts/"+c.id+"/pdf";
    await new TicketMessageRepository(this.db).createAssistantMessage(
      workerTicketScope(c.agentId,c.ticketId),c.ticketId,c.id,
      "Your private nonbinding TEST service contract "+c.contractNumber+" is ready with the"+
      " purchased service scope, a clearly marked ANCFZ demo signature,"+
      " and your uploaded identity document copies. "+
      "[Download your private TEST contract]("+link+").",[]);
  }
  private async recoverNotice(agentId:string):Promise<void>{
    const r=await this.db.withAgent(agentId,async client=>{
      const x=await client.query<{id:string;ticket_id:string;contract_number:string}>(
        "SELECT c.id,c.ticket_id,c.contract_number FROM ticket_service_contracts c "+
        "JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id AND "+
        "p.ticket_id=c.ticket_id AND p.id=c.payment_id AND p.state='verified_test_payment' "+
        "JOIN tickets t ON t.agent_id=c.agent_id AND t.id=c.ticket_id AND t.status<>'closed' "+
        "WHERE c.agent_id=$1 AND c.state='verified_completed' AND c.bytes IS NOT NULL "+
        "AND NOT EXISTS(SELECT 1 FROM ticket_messages m WHERE m.agent_id=c.agent_id "+
        "AND m.ticket_id=c.ticket_id AND m.role='assistant' AND m.request_id=c.id) "+
        "ORDER BY c.created_at LIMIT 1",[agentId]);
      return x.rows[0]??null;
    });
    if(r)await this.notify({id:r.id,agentId,ticketId:r.ticket_id,contractNumber:r.contract_number});
  }
  /**
   * n8n Data Table is a disposable, idempotent projection. PostgreSQL is
   * authoritative for contract numbers, ownership, renewal links and PDFs.
   * Only non-PII document references are dispatched. Missing n8n is nonfatal.
   */
  private async syncRegistry(agentId:string):Promise<void>{
    const next=await this.db.withAgent(agentId,async client=>{
      const result=await client.query<{
        id:string;ticket_id:string;contract_number:string;agreement_revision:number;
        quote_number:string;invoice_number:string;
      }>(
        `SELECT c.id,c.ticket_id,c.contract_number,c.agreement_revision,
           q.document_number AS quote_number,i.document_number AS invoice_number
         FROM ticket_service_contracts c
         JOIN ticket_quotations q ON q.agent_id=c.agent_id AND q.ticket_id=c.ticket_id
           AND q.id=c.quotation_id
         JOIN ticket_payment_invoices i ON i.agent_id=c.agent_id AND i.ticket_id=c.ticket_id
           AND i.payment_id=c.payment_id AND i.state='verified_completed'
         WHERE c.agent_id=$1 AND c.state='verified_completed'
           AND c.registry_sync_state='pending'
         ORDER BY c.created_at,c.id LIMIT 1`,[agentId]);
      return result.rows[0]??null;
    });
    if(!next)return;
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(!secret||secret.length<32)return;
    const ctrl=new AbortController();
    const timeout=setTimeout(()=>ctrl.abort(),12000);
    let saved=false;
    try{
      const response=await fetch("http://n8n:5678/webhook/ancfz/contract-registry",{
        method:"POST",redirect:"error",signal:ctrl.signal,
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify({
          agentKey:"ancfz",testOnly:true,contractId:next.id,
          contractNumber:next.contract_number,revision:next.agreement_revision,
          ticketId:next.ticket_id,quoteNumber:next.quote_number,
          invoiceNumber:next.invoice_number,status:"verified_completed",
        }),
      });
      if(response.ok){
        const raw=await response.text();
        if(raw.length<=2048){
          const answer=JSON.parse(raw) as Record<string,unknown>;
          saved=answer.status==="upserted"&&answer.testOnly===true&&
            answer.contractId===next.id;
        }
      }
    }catch{/* Uncertain webhook outcome: upsert replays by contractId only. */}
    finally{clearTimeout(timeout);}
    if(!saved){
      this.log({contractId:next.id},"Contract registry n8n sync pending");
      return;
    }
    await this.db.withAgent(agentId,async client=>{
      await client.query(
        "UPDATE ticket_service_contracts SET registry_sync_state='synced',updated_at=now() "+
        "WHERE agent_id=$1 AND id=$2 AND state='verified_completed' "+
        "AND registry_sync_state='pending'",[agentId,next.id]);
      await appendEventTx(client,agentId,next.ticket_id,"contract.registry_synced",{
        contractId:next.id,contractNumber:next.contract_number,
        revision:next.agreement_revision,testOnly:true,
      });
    });
  }
  private async tick():Promise<void>{
    if(this.stopped||this.busy||!paymentEnabled())return;
    this.busy=true;
    try{
      const agentId=await this.agentId();if(!agentId)return;
      await this.recoverMissingContract(agentId);
      await this.recoverUndiagnosedContract(agentId);
      const claim=await this.claim(agentId);
      if(!claim){await this.recoverNotice(agentId);await this.syncRegistry(agentId);return;}
      let bytes:Buffer|null=null;
      let failureCode:string|null=null;
      try{bytes=await this.render(claim);}catch(e){
        // Never log names, identity numbers, document bytes or OCR output.
        const code=(e as Error).message;
        failureCode=[
          "required_private_documents_missing","private_document_evidence_mismatch",
          "identity_names_do_not_match","verified_emirates_last4_missing",
          "emirates_id_ocr_mismatch","approved_package_scope_missing",
          "internal_pdf_renderer_unavailable","invalid_generated_pdf",
        ].includes(code)?code:"contract_render_failed";
      }
      const published=await this.db.withAgent(agentId,async client=>{
        const paid=await client.query<{state:string}>(
          "SELECT state FROM ticket_payment_attempts WHERE agent_id=$1 AND "+
          "ticket_id=$2 AND id=$3 FOR UPDATE",
          [agentId,claim.ticketId,claim.paymentId]);
        const row=await client.query<{state:string;render_attempts:number}>(
          "SELECT state,render_attempts FROM ticket_service_contracts "+
          "WHERE agent_id=$1 AND id=$2 FOR UPDATE",[agentId,claim.id]);
        if(row.rows[0]?.state!=="running")return false;
        const good=bytes!==null&&paid.rows[0]?.state==="verified_test_payment";
        const next=good?"verified_completed":row.rows[0].render_attempts<3?"queued":"needs_review";
        await client.query(
          "UPDATE ticket_service_contracts SET state=$3,bytes=$4,sha256=$5,"+
          "failure_code=$6,updated_at=now() WHERE agent_id=$1 AND id=$2",
          [agentId,claim.id,next,good?bytes:null,good?sha(bytes!):null,
            good?null:failureCode??"payment_not_verified"]);
        await appendEventTx(client,agentId,claim.ticketId,
          good?"contract.generated":next==="queued"?"contract.retry_scheduled":"contract.needs_review",
          {contractId:claim.id,contractNumber:claim.contractNumber,
            paymentId:claim.paymentId,testOnly:true,
            ...(!good?{failureCode:failureCode??"payment_not_verified"}:{})});
        return good;
      });
      if(published){
        try{await this.notify(claim);}catch{
          this.log({contractId:claim.id},"Private contract chat notice pending recovery");
        }
        try{await this.syncRegistry(agentId);}catch{
          this.log({contractId:claim.id},"Contract registry sync pending recovery");
        }
      }
      this.log({contractId:claim.id,contractNumber:claim.contractNumber,
        generated:published,...(!published?{failureCode}: {})},
        "ANCFZ sandbox contract rendered");
    }catch(e){
      this.log({errorCode:(e as Error).name},"ANCFZ contract worker failure");
    }finally{this.busy=false;}
  }
}
