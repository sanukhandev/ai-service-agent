/**
 * ANCFZ sandbox service contract.
 * A read-only PDF derivation of the exact paid quotation, plus privately held
 * passport and Emirates ID annexures. Never produces a legal e-signature.
 * No AI, browser, public URL or n8n receives identity document bytes.
 */
import {createHash} from "node:crypto";
import {PersistenceDatabase} from "../database/pool.js";
import {appendEventTx} from "../repositories/events.js";
import {TicketMessageRepository} from "../repositories/messages.js";
import {workerTicketScope} from "../repositories/types.js";
import {paymentEnabled} from "./payment-evidence.js";
import {extractInvoiceEmiratesId,nameKey} from "./identity-extractor.js";
import {invoiceQuoteDetails} from "./invoice-details.js";
import type {QuoteProposalDetails} from "./quote-proposal.js";

type IdentityFile={
  kind:"passport"|"emirates_id";name:string;contentType:string;
  bytes:Buffer;sha256:string;extractedName:string;last4:string|null;
};
type Claim={
  id:string;agentId:string;ticketId:string;quotationId:string;
  paymentId:string;documentNumber:string;offering:string;
  amount:string;currency:string;quoteNumber:string;invoiceNumber:string;
  agreementNumber:string;revision:number;quotePayload:unknown;
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
function assertFiles(files:IdentityFile[]):void{
  if(files.length!==2||!files.some(f=>f.kind==="passport")||
     !files.some(f=>f.kind==="emirates_id"))
    throw new Error("required_private_documents_missing");
  for(const f of files){
    if(!f.extractedName||f.bytes.length<100||f.bytes.length>1048576||
       sha(f.bytes)!==f.sha256||
       !["application/pdf","image/png","image/jpeg"].includes(f.contentType)||
       (f.contentType==="application/pdf"&&!validPdf(f.bytes)))
      throw new Error("private_document_evidence_mismatch");
  }
  if(nameKey(files[0]!.extractedName)!==nameKey(files[1]!.extractedName))
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
    "<p>Agreement number: "+short(c.agreementNumber,100)+" | Revision: "+String(c.revision)+
    " | Prepared: "+now+"</p>"+
    "<p>Quotation number: "+short(c.quoteNumber,100)+
    " | Invoice number: "+short(c.invoiceNumber,100)+"</p>"+
    "<h2>1. Parties and identification</h2>"+
    "<p>Provider: ANCFZ (sandbox demonstration). Customer: "+short(id.name,150)+
    ". Emirates ID: "+short(id.number,20)+".</p>"+
    "<p>Identity references are based on the uploaded customer documents and OCR, not government authenticity verification.</p>"+
    "<h2>2. Purchased package</h2>"+
    "<table><tr><th>Package</th><th>Amount</th></tr><tr><td>"+
    short(c.offering,200)+"</td><td>"+short(c.currency,3)+" "+short(c.amount,20)+"</td></tr></table>"+
    "<p>Approved quotation: "+short(c.quoteNumber,100)+
    " | Paid invoice: "+short(c.invoiceNumber,100)+
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
  private async claim(agentId:string):Promise<Claim|null>{
    return this.db.withAgent(agentId,async client=>{
      await client.query(
        "UPDATE ticket_service_contracts SET state=CASE WHEN render_attempts>=3 "+
        "THEN 'needs_review' ELSE 'queued' END,updated_at=now() "+
        "WHERE agent_id=$1 AND state='running' AND updated_at<now()-interval '5 minutes'",
        [agentId]);
      const r=await client.query<{
        id:string;ticket_id:string;quotation_id:string;payment_id:string;
        document_number:string;offering_label:string;amount:string;
        currency:string;quote_document_number:string;invoice_document_number:string;
        agreement_number:string;revision:number;quote_payload:unknown;
      }>(
        "SELECT c.id,c.ticket_id,c.quotation_id,c.payment_id,c.document_number,"+
        "a.agreement_number,c.revision,i.document_number AS invoice_document_number,"+
        "q.offering_label,q.amount::text AS amount,q.currency,"+
        "q.document_number AS quote_document_number,qe.payload AS quote_payload "+
        "FROM ticket_service_contracts c "+
        "JOIN service_agreements a ON a.agent_id=c.agent_id AND a.id=c.agreement_id "+
        "JOIN ticket_payment_invoices i ON i.agent_id=c.agent_id AND i.ticket_id=c.ticket_id "+
        "AND i.id=c.invoice_id AND i.payment_id=c.payment_id AND i.quotation_id=c.quotation_id "+
        "AND i.state='verified_completed' AND i.bytes IS NOT NULL "+
        "JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id AND p.ticket_id=c.ticket_id "+
        "AND p.id=c.payment_id AND p.quotation_id=c.quotation_id "+
        "AND p.state='verified_test_payment' "+
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
        bytes:Buffer;sha256:string;extracted_full_name:string;
        document_number_last4:string|null;
      }>(
        "SELECT req.requirement_key,d.file_name,d.content_type,d.bytes,d.sha256,"+
        "d.extracted_full_name,d.document_number_last4 "+
        "FROM ticket_purchase_documents d "+
        "JOIN intent_document_requirements req ON req.agent_id=d.agent_id "+
        "AND req.intent_id=d.intent_id AND req.id=d.requirement_id "+
        "JOIN ticket_purchase_confirmations pc ON pc.agent_id=d.agent_id "+
        "AND pc.ticket_id=d.ticket_id AND pc.intent_id=d.intent_id "+
        "AND pc.quotation_id=$3 "+
        "WHERE d.agent_id=$1 AND d.ticket_id=$2 AND d.state='received' "+
        "AND d.extraction_status='extracted' "+
        "AND req.requirement_key IN ('passport','emirates_id') "+
        "AND pc.consent_text LIKE '%nonbinding TEST service contract%'",
        [agentId,x.ticket_id,x.quotation_id]);
      await client.query(
        "UPDATE ticket_service_contracts SET state='running',render_attempts=render_attempts+1,"+
        "updated_at=now() WHERE agent_id=$1 AND id=$2",
        [agentId,x.id]);
      return {
        id:x.id,agentId,ticketId:x.ticket_id,quotationId:x.quotation_id,
        paymentId:x.payment_id,documentNumber:x.document_number,
        offering:x.offering_label,amount:x.amount,currency:x.currency.trim(),
        quoteNumber:x.quote_document_number,invoiceNumber:x.invoice_document_number,
        agreementNumber:x.agreement_number,revision:x.revision,quotePayload:x.quote_payload,
        documents:docs.rows.map(d=>({
          kind:d.requirement_key,name:d.file_name,contentType:d.content_type,
          bytes:d.bytes,sha256:d.sha256,extractedName:d.extracted_full_name,
          last4:d.document_number_last4,
        })),
      };
    });
  }
  private async render(c:Claim):Promise<Buffer>{
    assertFiles(c.documents);
    const emirates=c.documents.find(f=>f.kind==="emirates_id")!;
    // Preserve previously validated OCR evidence if a second OCR pass
    // fails. Never fabricate a full identity number.
    if(!/^[0-9]{4}$/.test(emirates.last4??""))
      throw new Error("emirates_id_evidence_missing");
    let identityNumber="XXXX-XXXX-XXXX-"+emirates.last4;
    try{
      const extracted=await extractInvoiceEmiratesId(emirates.bytes);
      if(extracted.last4===emirates.last4 &&
         nameKey(extracted.fullName)===nameKey(emirates.extractedName))
        identityNumber=extracted.number;
    }catch{/* Prior verified last-four remains safe. */}
    const proposal=invoiceQuoteDetails(c.quotePayload,{
      quotationDocumentNumber:c.quoteNumber,amount:c.amount,currency:c.currency,
    });
    if(!proposal||!proposal.packageDescription.trim())
      throw new Error("approved_package_scope_missing");
    const contract=await htmlPdf(contractHtml(c,proposal,{
      name:emirates.extractedName,number:identityNumber,
    }));
    const passport=c.documents.find(f=>f.kind==="passport")!;
    const parts=[contract,await annexPdf(passport),await annexPdf(emirates)];
    return gotenberg("/forms/pdfengines/merge",parts.map((bytes,i)=>({
      name:String(i+1).padStart(2,"0")+".pdf",type:"application/pdf",bytes,
    })));
  }
  private async notify(c:Pick<Claim,"id"|"agentId"|"ticketId">):Promise<void>{
    const link="/api/v1/tickets/"+c.ticketId+"/contracts/"+c.id+"/pdf";
    await new TicketMessageRepository(this.db).createAssistantMessage(
      workerTicketScope(c.agentId,c.ticketId),c.ticketId,c.id,
      "Your private nonbinding TEST service contract is ready with the"+
      " purchased service scope, a clearly marked ANCFZ demo signature,"+
      " and your uploaded identity document copies. "+
      "[Download your private TEST contract]("+link+").",[]);
  }
  private async recoverNotice(agentId:string):Promise<void>{
    const r=await this.db.withAgent(agentId,async client=>{
      const x=await client.query<{id:string;ticket_id:string}>(
        "SELECT c.id,c.ticket_id FROM ticket_service_contracts c "+
        "JOIN ticket_payment_attempts p ON p.agent_id=c.agent_id AND "+
        "p.ticket_id=c.ticket_id AND p.id=c.payment_id AND p.state='verified_test_payment' "+
        "JOIN tickets t ON t.agent_id=c.agent_id AND t.id=c.ticket_id AND t.status<>'closed' "+
        "WHERE c.agent_id=$1 AND c.state='verified_completed' AND c.bytes IS NOT NULL "+
        "AND NOT EXISTS(SELECT 1 FROM ticket_messages m WHERE m.agent_id=c.agent_id "+
        "AND m.ticket_id=c.ticket_id AND m.role='assistant' AND m.request_id=c.id) "+
        "ORDER BY c.created_at LIMIT 1",[agentId]);
      return x.rows[0]??null;
    });
    if(r)await this.notify({id:r.id,agentId,ticketId:r.ticket_id});
  }
  private async tick():Promise<void>{
    if(this.stopped||this.busy||!paymentEnabled())return;
    this.busy=true;
    try{
      const agentId=await this.agentId();if(!agentId)return;
      const claim=await this.claim(agentId);
      if(!claim){await this.recoverNotice(agentId);return;}
      let bytes:Buffer|null=null;
      try{bytes=await this.render(claim);}catch{
        // Never log names, identity numbers, document bytes or OCR output.
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
          "UPDATE ticket_service_contracts SET state=$3,bytes=$4,sha256=$5,updated_at=now() "+
          "WHERE agent_id=$1 AND id=$2",
          [agentId,claim.id,next,good?bytes:null,good?sha(bytes!):null]);
        if(good){
          await client.query(
            "UPDATE service_agreements SET current_revision=GREATEST(current_revision,$3),"+
            "sync_state='pending',sync_attempts=0,next_sync_at=now(),updated_at=now() "+
            "WHERE agent_id=$1 AND agreement_number=$2",
            [agentId,claim.agreementNumber,claim.revision]);
        }
        await appendEventTx(client,agentId,claim.ticketId,
          good?"contract.generated":next==="queued"?"contract.retry_scheduled":"contract.needs_review",
          {contractId:claim.id,paymentId:claim.paymentId,testOnly:true});
        return good;
      });
      if(published){
        try{await this.notify(claim);}catch{
          this.log({contractId:claim.id},"Private contract chat notice pending recovery");
        }
      }
      this.log({contractId:claim.id,generated:published},
        "ANCFZ sandbox contract rendered");
    }catch(e){
      this.log({errorCode:(e as Error).name},"ANCFZ contract worker failure");
    }finally{this.busy=false;}
  }
}
