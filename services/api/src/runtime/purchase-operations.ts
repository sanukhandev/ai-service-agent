/**
 * Node-owned purchase preflight, ticket-private document intake and explicit
 * quote-specific purchase confirmation. No model or n8n path can mutate it.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PersistenceDatabase, PersistenceError, requireUuid } from "../database/pool.js";
import { authorizedTicket, type TicketScope } from "../repositories/types.js";
import { appendEventTx } from "../repositories/events.js";
import { quoteConfirmedTx } from "./quotation-confirmation.js";
import { extractIdentityDocument, nameKey, allowUnnamedSyntheticPassport, type ExtractedIdentity, type IdentityKind } from "./identity-extractor.js";

export const PURCHASE_CONSENT =
  "I confirm this ANCFZ sandbox purchase for the exact approved quotation amount and consent to my uploaded passport and Emirates ID copies being included as private annexures in a nonbinding TEST service contract after independently verified sandbox payment.";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_FILE=1048576;
type PurchaseQuote={id:string|null;intent_id:string;intent_key:string;amount:string|null;currency:string|null;state:string|null;purchase_enabled:boolean};
type DocRow={id:string|null;requirement_key:string;label:string;guidance:string|null;
  required:boolean;sort_order:number;file_name:string|null;content_type:string|null;
  state:string|null;created_at:Date|null;extracted_full_name:string|null;
  extraction_status:string|null;extraction_model:string|null};
export type PurchaseStatus={
  supported:boolean;intentKey:string|null;quotationId:string|null;amount:string|null;currency:string|null;
  requirements:Array<{key:string;label:string;guidance:string|null;required:boolean;
    uploaded:boolean;fileName:string|null;documentId:string|null;status:string}>;
  confirmed:boolean;readyForOtp:boolean;missing:string[];billingName:string|null;
  persona:{name:string;tone:string};
};
async function findQuote(client:PoolClient,agentId:string,ticketId:string):Promise<PurchaseQuote|null>{
  const r=await client.query<PurchaseQuote>(
    `SELECT q.id,i.id AS intent_id,i.intent_key,q.amount::text AS amount,
       q.currency,op.state,
       ('purchase_quotation'=ANY(i.allowed_actions)) AS purchase_enabled
     FROM tickets t
     JOIN ticket_intents ti ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id
       AND ti.status='active'
     JOIN intents i ON i.agent_id=t.agent_id AND i.id=ti.intent_id
       AND i.catalog_version_id=t.intent_catalog_version_id
     LEFT JOIN ticket_quotations q ON q.agent_id=t.agent_id AND q.ticket_id=t.id
       AND EXISTS (
         SELECT 1 FROM offerings o
         WHERE o.agent_id=q.agent_id AND o.id=q.offering_id
           AND (o.intent_key=i.intent_key OR (
          i.intent_key IN ('quotation_request','package_comparison')
          AND o.intent_key IN ('company_formation','package_comparison')
        ))
       )
     LEFT JOIN ticket_operations op ON op.agent_id=t.agent_id AND op.ticket_id=t.id
       AND op.id=q.operation_id AND op.operation_key='ancfz_render_quote'
     WHERE t.agent_id=$1 AND t.id=$2 AND t.status<>'closed'
     LIMIT 1`,
    [agentId,ticketId],
  );
  const v=r.rows[0];
  // When a supported intent exists but a quote hasn't been created yet,
  // SELECT returns null for q.id; keep the checklist visible while waiting.
  return v??null;
}
async function getRequirements(client:PoolClient,agentId:string,ticketId:string,intentId:string):Promise<DocRow[]>{
  const r=await client.query<DocRow>(
    `SELECT d.id AS id,r.requirement_key,r.label,r.guidance,r.required,r.sort_order,
       d.file_name,d.content_type,d.state,d.created_at,
       d.extracted_full_name,d.extraction_status,d.extraction_model
     FROM intent_document_requirements r
     LEFT JOIN ticket_purchase_documents d
       ON d.agent_id=r.agent_id AND d.ticket_id=$2
       AND d.intent_id=r.intent_id AND d.requirement_id=r.id
     WHERE r.agent_id=$1 AND r.intent_id=$3
     ORDER BY r.sort_order,r.requirement_key`,
    [agentId,ticketId,intentId],
  );
  return r.rows;
}
async function confirmation(client:PoolClient,agentId:string,ticketId:string,q:PurchaseQuote):Promise<boolean>{
  if(!q.id)return false;
  const r=await client.query(
    `SELECT 1 FROM ticket_purchase_confirmations
      WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3 AND intent_id=$4
        AND amount=$5::numeric AND currency=$6 LIMIT 1`,
    [agentId,ticketId,q.id,q.intent_id,q.amount,q.currency?.trim()??""],
  );
  return (r.rowCount??0)>0;
}
async function persona(client:PoolClient,agentId:string,ticketId:string){
  const found=await client.query<{name:string|null;tone:string|null}>(
    `SELECT v.persona_config->>'name' AS name,v.persona_config->>'tone' AS tone
     FROM tickets t JOIN agent_versions v ON v.agent_id=t.agent_id AND v.id=t.agent_version_id
     WHERE t.agent_id=$1 AND t.id=$2`,[agentId,ticketId],
  );
  const name=found.rows[0]?.name;
  const tone=found.rows[0]?.tone;
  return {name:typeof name==="string" && /^[\p{L} .'-]{1,60}$/u.test(name)?name:"Sara",
    tone:typeof tone==="string" && ["professional","friendly","formal","concise"].includes(tone)?tone:"professional"};
}
type DocumentContentType="application/pdf"|"image/png"|"image/jpeg";
function validateBase64(b:unknown):{bytes:Buffer;contentType:DocumentContentType}{
  if(typeof b!=="string" || b.length<136 || b.length>Math.ceil(MAX_FILE/3)*4+8 ||
     !/^[A-Za-z0-9+/]+={0,2}$/.test(b) || b.length%4!==0)
    throw new PersistenceError("INVALID_INPUT","Invalid or oversized document data");
  const bytes=Buffer.from(b,"base64");
  if(bytes.length<100||bytes.length>MAX_FILE||bytes.toString("base64")!==b)
    throw new PersistenceError("INVALID_INPUT","Invalid or oversized document");
  // Browser-supplied MIME types are not authoritative. Detect the supported
  // format from the bytes and persist that canonical type in PostgreSQL.
  const pdf=bytes.subarray(0,5).toString("ascii")==="%PDF-";
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg=bytes.length>3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const contentType:DocumentContentType|undefined=pdf?"application/pdf":
    png?"image/png":jpg?"image/jpeg":undefined;
  if(!contentType)
    throw new PersistenceError("INVALID_INPUT","Only PDF, PNG or JPEG documents are supported");
  return {bytes,contentType};
}

/** Tolerant browser metadata, strict document bytes and allowlisted requirement. */
export function preparePurchaseDocumentUpload(raw:unknown):{
  requirementKey:IdentityKind;fileName:string;contentType:DocumentContentType;bytes:Buffer;
}{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new PersistenceError("INVALID_INPUT","Document request required");
  const v=raw as Record<string,unknown>;
  if(v.requirementKey!=="passport"&&v.requirementKey!=="emirates_id")
    throw new PersistenceError("INVALID_INPUT","Unsupported document requirement");
  const {bytes,contentType}=validateBase64(v.dataBase64);
  const extension=contentType==="application/pdf"?"pdf":contentType==="image/png"?"png":"jpg";
  // Keep common download names such as "Passport (1).pdf" and Unicode names.
  // Strip path separators, control and bidirectional override characters.
  const candidate=typeof v.fileName==="string"?v.fileName.normalize("NFC"):"";
  const cleaned=candidate.replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,"_").trim();
  const fileName=cleaned && cleaned!=="." && cleaned!==".."
    ? Array.from(cleaned).slice(0,150).join("")
    : v.requirementKey+"."+extension;
  return {requirementKey:v.requirementKey,fileName,contentType,bytes};
}
/** Accept a classified synthetic passport without a name only for local POC. */
function unnamedSyntheticPassport(d:DocRow):boolean{
  return allowUnnamedSyntheticPassport() && d.requirement_key==="passport" &&
    d.state==="received" && d.extraction_status==="pending" &&
    d.extraction_model==="prebuilt-idDocument" && !d.extracted_full_name;
}
function documentReady(d:DocRow):boolean{
  return d.state==="received" &&
    ((d.extraction_status==="extracted" && Boolean(d.extracted_full_name)) ||
      unnamedSyntheticPassport(d));
}
function extractedBillingName(docs:DocRow[]):string{
  const allowed=new Set(["passport","emirates_id"]);
  if(docs.length!==2||docs.some(d=>!allowed.has(d.requirement_key)))
    throw new PersistenceError("CONFLICT","This POC accepts only passport and Emirates ID");
  const passport=docs.find(d=>d.requirement_key==="passport");
  const emirates=docs.find(d=>d.requirement_key==="emirates_id");
  if(!passport||!emirates||!documentReady(passport)||
     emirates.state!=="received"||emirates.extraction_status!=="extracted"||
     !emirates.extracted_full_name)
    throw new PersistenceError("CONFLICT","Both ID documents must be read before purchase");
  if(passport.extracted_full_name &&
     nameKey(passport.extracted_full_name)!==nameKey(emirates.extracted_full_name))
    throw new PersistenceError("CONFLICT","Passport and Emirates ID holder names differ; request review");
  // The fallback is explicitly synthetic and does NOT claim the passport
  // name was extracted. The TEST invoice uses the Emirates ID name.
  return passport.extracted_full_name ?? emirates.extracted_full_name;
}
export async function identityDocumentReadinessTx(
 client:PoolClient,agentId:string,ticketId:string,intentId:string,
):Promise<{ready:boolean;missing:string[]}>{
  const docs=await getRequirements(client,agentId,ticketId,intentId);
  const missing=docs.filter(d=>d.required&&!documentReady(d)).map(d=>d.requirement_key);
  if(missing.length)return {ready:false,missing};
  try{extractedBillingName(docs);return {ready:true,missing:[]};}
  catch{return {ready:false,missing:["identity_name_mismatch"]};}
}
export async function assertIdentityDocumentsReadyTx(
 client:PoolClient,agentId:string,ticketId:string,intentId:string,
):Promise<string>{
  const docs=await getRequirements(client,agentId,ticketId,intentId);
  return extractedBillingName(docs);
}
export async function invoiceBillingName(
 client:PoolClient,agentId:string,ticketId:string,quotationId:string,
):Promise<string>{
  const q=await findQuote(client,agentId,ticketId);
  if(!q||!q.purchase_enabled||q.id!==quotationId||q.state!=="verified_completed")
    throw new PersistenceError("CONFLICT","Invoice identity is not linked to the approved quotation");
  const docs=await getRequirements(client,agentId,ticketId,q.intent_id);
  return extractedBillingName(docs);
}
export async function assertPurchaseReady(
  client:PoolClient,agentId:string,ticketId:string,quotationId:string,
):Promise<void>{
  const q=await findQuote(client,agentId,ticketId);
  if(!q||!q.purchase_enabled||q.id!==quotationId||q.state!=="verified_completed")
    throw new PersistenceError("CONFLICT","Select a purchase-enabled intent and obtain a verified quotation");
  if(!await quoteConfirmedTx(client,agentId,ticketId,quotationId))
    throw new PersistenceError("CONFLICT","Verify the quotation OTP before purchase");
  const docs=await getRequirements(client,agentId,ticketId,q.intent_id);
  // A catalog with no configured requirements is not authorization to skip intake.
  extractedBillingName(docs);
  if(!(await confirmation(client,agentId,ticketId,q)))
    throw new PersistenceError("CONFLICT","Customer purchase confirmation is required before OTP");
}
export class PurchaseOperations {
  constructor(
    private readonly db:PersistenceDatabase,
    private readonly extract:(bytes:Buffer,kind:IdentityKind)=>Promise<ExtractedIdentity>=extractIdentityDocument,
  ){}
  async read(scope:TicketScope,ticketId:string):Promise<PurchaseStatus>{
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const q=await findQuote(client,scope.agentId,ticketId);
      const branding=await persona(client,scope.agentId,ticketId);
      if(!q)return {supported:false,intentKey:null,quotationId:null,amount:null,currency:null,
        requirements:[],confirmed:false,readyForOtp:false,missing:[],billingName:null,persona:branding};
      const documents=await getRequirements(client,scope.agentId,ticketId,q.intent_id);
      const confirmed=await confirmation(client,scope.agentId,ticketId,q);
      const missing=documents.filter(d=>d.required&&!documentReady(d)).map(d=>d.requirement_key);
      let billingName:string|null=null;
      try{billingName=extractedBillingName(documents);}catch{/* Keep checklist pending on mismatch. */}
      if(!billingName && missing.length===0)missing.push("identity_name_mismatch");
      const reqs=documents.map(d=>({
        key:d.requirement_key,label:d.label,guidance:d.guidance,required:d.required,
        uploaded:documentReady(d),fileName:d.file_name??null,
        documentId:d.state==="received"?d.id:null,
        status:unnamedSyntheticPassport(d)?"synthetic_name_unverified":d.state??"missing",
      }));
      return {supported:true,intentKey:q.intent_key,quotationId:q.id??null,
        amount:q.amount??null,currency:q.currency?.trim()??null,
        requirements:reqs,confirmed,readyForOtp:q.purchase_enabled&&confirmed&&documents.length>0&&missing.length===0
          &&billingName!==null&&q.state==="verified_completed",missing,billingName,persona:branding};
    });
  }
  async upload(scope:TicketScope,ticketId:string,raw:unknown){
    requireUuid(ticketId,"ticketId");
    const v=preparePurchaseDocumentUpload(raw);
    const {bytes}=v;
    const digest=createHash("sha256").update(bytes).digest("hex");
    // Check eligibility before sending identity bytes to the OCR service.
    await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const q=await findQuote(client,scope.agentId,ticketId);
      if(!q)
        throw new PersistenceError("CONFLICT","Select a document-enabled service before uploading documents");
      // Non-quotation service requests use this intake too. Quote OTP is
      // required only where a formal quotation actually exists.
      if(q.id && (q.state!=="verified_completed"||
         !await quoteConfirmedTx(client,scope.agentId,ticketId,q.id)))
        throw new PersistenceError("CONFLICT","Verify the quotation OTP before uploading identity documents");
      if(await confirmation(client,scope.agentId,ticketId,q))
        throw new PersistenceError("CONFLICT","Purchase documents are locked");
      const req=await client.query(
        "SELECT 1 FROM intent_document_requirements WHERE agent_id=$1 AND intent_id=$2 AND requirement_key=$3",
        [scope.agentId,q.intent_id,v.requirementKey]);
      if(req.rowCount!==1)
        throw new PersistenceError("INVALID_INPUT","Unsupported document requirement");
    });
    const extracted=await this.extract(bytes,v.requirementKey as IdentityKind);
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const q=await findQuote(client,scope.agentId,ticketId);
      if(!q)
        throw new PersistenceError("CONFLICT","Select a document-enabled service before uploading documents");
      // Non-quotation service requests use this intake too. Quote OTP is
      // required only where a formal quotation actually exists.
      if(q.id && (q.state!=="verified_completed"||
         !await quoteConfirmedTx(client,scope.agentId,ticketId,q.id)))
        throw new PersistenceError("CONFLICT","Verify the quotation OTP before uploading identity documents");
      if(await confirmation(client,scope.agentId,ticketId,q))
        throw new PersistenceError("CONFLICT","Documents are locked after purchase confirmation");
      const req=await client.query<{id:string}>(
        `SELECT id FROM intent_document_requirements
          WHERE agent_id=$1 AND intent_id=$2 AND requirement_key=$3`,
        [scope.agentId,q.intent_id,v.requirementKey],
      );
      const reqId=req.rows[0]?.id;
      if(!reqId)throw new PersistenceError("INVALID_INPUT","Unrecognized document requirement");
      const existing=await client.query<{id:string;sha256:string}>(
        `SELECT id,sha256 FROM ticket_purchase_documents
          WHERE agent_id=$1 AND ticket_id=$2 AND requirement_id=$3 FOR UPDATE`,
        [scope.agentId,ticketId,reqId],
      );
      if(existing.rows[0]){
        const previous=existing.rows[0];
        if(previous.sha256===digest)
          return {documentId:previous.id,requirementKey:v.requirementKey,duplicated:true};
        // Authorized ticket row lock serializes correction against confirmation.
        await client.query(
          `UPDATE ticket_purchase_documents
             SET file_name=$4,content_type=$5,bytes=$6,sha256=$7,
                 extracted_full_name=$8,document_number_last4=$9,
                 extraction_model=$10,extraction_status=$11,replaced_at=now()
           WHERE agent_id=$1 AND ticket_id=$2 AND id=$3`,
          [scope.agentId,ticketId,previous.id,v.fileName,v.contentType,bytes,digest,
            extracted.fullName,extracted.documentNumberLast4,extracted.model,
            extracted.fullName?"extracted":"pending"],
        );
        // Audit both hashes without retaining outdated private document bytes.
        await appendEventTx(client,scope.agentId,ticketId,"purchase.document.replaced",{
          documentId:previous.id,requirementKey:v.requirementKey,
          previousSha256:previous.sha256,sha256:digest,
        });
        return {documentId:previous.id,requirementKey:v.requirementKey,replaced:true,duplicated:false};
      }
      const documentId=randomUUID();
      await client.query(
        `INSERT INTO ticket_purchase_documents(
          id,agent_id,ticket_id,intent_id,requirement_id,file_name,content_type,bytes,sha256,
          extracted_full_name,document_number_last4,extraction_model,extraction_status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [documentId,scope.agentId,ticketId,q.intent_id,reqId,v.fileName,v.contentType,bytes,digest,
          extracted.fullName,extracted.documentNumberLast4,extracted.model,
          extracted.fullName?"extracted":"pending"],
      );
      await appendEventTx(client,scope.agentId,ticketId,"purchase.document.received",{
        documentId,requirementKey:v.requirementKey,sha256:digest});
      return {documentId,requirementKey:v.requirementKey,duplicated:false};
    });
  }
  async confirm(scope:TicketScope,ticketId:string,raw:unknown){
    requireUuid(ticketId,"ticketId");
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Purchase confirmation required");
    const v=raw as Record<string,unknown>;
    if(Object.keys(v).some(k=>!["requestId","quotationId","amount","currency","consent","consentText"].includes(k))||
       typeof v.requestId!=="string"||!uuid.test(v.requestId)||
       typeof v.quotationId!=="string"||!uuid.test(v.quotationId)||
       typeof v.amount!=="string"||!/^\d{1,12}\.\d{2}$/.test(v.amount)||
       v.currency!=="AED"||v.consent!==true||v.consentText!==PURCHASE_CONSENT)
      throw new PersistenceError("INVALID_INPUT","Exact-amount purchase consent required");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const q=await findQuote(client,scope.agentId,ticketId);
      if(!q||!q.id||!q.purchase_enabled||!q.currency||q.id!==v.quotationId||q.state!=="verified_completed"||
         q.amount!==v.amount||q.currency?.trim()!==v.currency)
        throw new PersistenceError("CONFLICT","Verified quoted amount and intent do not match");
      if(!await quoteConfirmedTx(client,scope.agentId,ticketId,q.id))
        throw new PersistenceError("CONFLICT","Verify the quotation OTP before purchase consent");
      const docs=await getRequirements(client,scope.agentId,ticketId,q.intent_id);
      // Validation uses OCR-derived names, not untrusted chat or uploaded filenames.
      extractedBillingName(docs);
      const existing=await client.query<{request_id:string}>(
        `SELECT request_id FROM ticket_purchase_confirmations
          WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3`,
        [scope.agentId,ticketId,q.id],
      );
      if(existing.rows[0]){
        if(existing.rows[0].request_id!==v.requestId)
          throw new PersistenceError("CONFLICT","Purchase already confirmed for this quotation");
        return {confirmed:true,duplicated:true,quotationId:q.id};
      }
      await client.query(
        `INSERT INTO ticket_purchase_confirmations(
          agent_id,ticket_id,quotation_id,intent_id,request_id,amount,currency,consent_text)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [scope.agentId,ticketId,q.id,q.intent_id,v.requestId,q.amount,q.currency.trim(),PURCHASE_CONSENT],
      );
      await appendEventTx(client,scope.agentId,ticketId,"purchase.confirmed",{
        quotationId:q.id,intentKey:q.intent_key,amount:q.amount,currency:q.currency.trim()});
      return {confirmed:true,duplicated:false,quotationId:q.id};
    });
  }
  async download(scope:TicketScope,ticketId:string,documentId:string){
    requireUuid(ticketId,"ticketId");requireUuid(documentId,"documentId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const r=await client.query<{bytes:Buffer;content_type:string;file_name:string}>(
        `SELECT bytes,content_type,file_name FROM ticket_purchase_documents
          WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND state='received'`,
        [scope.agentId,ticketId,documentId],
      );
      if(!r.rows[0])throw new PersistenceError("NOT_FOUND","Document not found");
      return r.rows[0];
    });
  }
}
