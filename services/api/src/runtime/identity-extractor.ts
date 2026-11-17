/**
 * Azure Document Intelligence v4 ID-document extraction for the POC.
 * The submitted bytes are delivered only to the configured Azure endpoint.
 * Never persist raw OCR JSON, birth dates, full ID numbers or full MRZ text.
 * A recognized name is NOT identity or document authenticity verification.
 */
import { PersistenceError } from "../database/pool.js";

export type IdentityKind="passport"|"emirates_id";
export type ExtractedIdentity={
  fullName:string|null;
  documentNumberLast4:string|null;
  model:"prebuilt-idDocument";
};

type Field={valueString?:unknown;content?:unknown;confidence?:unknown};
function obj(value:unknown):Record<string,unknown>{
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ? value as Record<string,unknown> : {};
}
function field(fields:Record<string,unknown>,keys:string[]):string|null {
  for(const key of keys){
    const f=obj(fields[key]) as Field;
    const value=typeof f.valueString==="string"?f.valueString:
      typeof f.content==="string"?f.content:null;
    if(value && value.length<=220 && (!Number.isFinite(f.confidence) || Number(f.confidence)>=0.50))
      return value.trim();
  }
  return null;
}
export function normalizeBillingName(input:string):string {
  return input.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/g,"")
    .replace(/\s+/g," ").trim();
}
export function nameKey(input:string):string{
  return normalizeBillingName(input).toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N} ]/gu,"").split(" ").filter(Boolean).sort().join(" ");
}
/** The sandbox exception never applies to production, even with the flag set. */
export function allowUnnamedSyntheticPassport(
  env:NodeJS.ProcessEnv=process.env,
):boolean{
  return env.APP_ENV==="development" &&
    env.ANCFZ_DEV_ACCEPT_UNNAMED_PASSPORT==="true";
}
function validFullName(value:string):boolean{
  return value.length>=3 && value.length<=200 &&
    value.split(" ").length>=2 && /[\p{L}]/u.test(value) &&
    !/[^\p{L}\p{M}\p{N} .'’-]/u.test(value);
}
export function parseIdentityResult(
  raw:unknown,kind:IdentityKind,allowUnnamedPassport=false,
):ExtractedIdentity{
  const result=obj(raw);
  const analysis=obj(result["analyzeResult"]);
  const docs=analysis["documents"];
  if(result["status"]!=="succeeded" || !Array.isArray(docs)||docs.length!==1)
    throw new PersistenceError("CONFLICT","Identity document could not be extracted");
  const doc=obj(docs[0]),fields=obj(doc["fields"]);
  const modelType=String(doc["docType"]??"").toLowerCase();
  const description=(field(fields,["DocumentType"])??"").toLowerCase();
  if(kind==="passport" && !modelType.includes("passport") && !description.includes("passport"))
    throw new PersistenceError("CONFLICT","Uploaded document was not identified as a passport");
  if(kind==="emirates_id" && (modelType.includes("passport") || description.includes("passport")))
    throw new PersistenceError("CONFLICT","The Emirates ID upload appears to be a passport");
  const combined=field(fields,["FullName","FullNameEnglish","Name","NameEnglish","PersonName"]);
  const first=field(fields,["FirstName","GivenNames","GivenName","GivenNameEnglish"]);
  const last=field(fields,["LastName","Surname","FamilyName","SurnameEnglish"]);
  // Azure may produce a single-word FullName alongside valid given/family names.
  // Try both candidates before rejecting an otherwise classified document.
  const candidates=[combined,[first,last].filter(Boolean).join(" ")]
    .filter((value):value is string=>Boolean(value))
    .map(normalizeBillingName);
  const fullName=candidates.find(validFullName)??null;
  if(!fullName && !(kind==="passport"&&allowUnnamedPassport&&allowUnnamedSyntheticPassport()))
    throw new PersistenceError("CONFLICT",kind+" document did not yield a reliable full name");
  const number=field(fields,kind==="passport"
    ? ["DocumentNumber","PassportNumber"]
    : ["DocumentNumber","IdNumber","IdentificationNumber","PersonalNumber"]);
  let normalizedNumber=number?.replace(/[^A-Za-z0-9]/g,"")??"";
  if(kind==="emirates_id"){
    const text=typeof analysis["content"]==="string"?analysis["content"]:"";
    const match=text.match(/(?:^|[^0-9])(784[- ]?\d{4}[- ]?\d{7}[- ]?\d)(?:$|[^0-9])/);
    if(!/^784\d{12}$/.test(normalizedNumber)){
      normalizedNumber=match?.[1]?.replace(/[^0-9]/g,"")??"";
    }
    if(!/^784\d{12}$/.test(normalizedNumber))
      throw new PersistenceError("CONFLICT","Emirates ID number could not be recognized from the submitted document");
  }
  return {fullName,documentNumberLast4:normalizedNumber.length>=4
    ? normalizedNumber.slice(-4).toUpperCase():null,
    model:"prebuilt-idDocument"};
}
/** Invoice-only extraction from the same private Azure OCR evidence.
 * The full number is returned to the invoice renderer in memory only; never
 * write it to ticket facts, chat, events, logs or an independent DB column. */
export function parseInvoiceEmiratesId(raw:unknown):{fullName:string;number:string;last4:string}{
  const parsed=parseIdentityResult(raw,"emirates_id");
  if(!parsed.fullName||!parsed.documentNumberLast4)
    throw new PersistenceError("CONFLICT","Invoice identity evidence unavailable");
  const analysis=obj(obj(raw)["analyzeResult"]);
  const docs=analysis["documents"];
  const doc=Array.isArray(docs)?obj(docs[0]):{};
  const fields=obj(doc["fields"]);
  const fieldNumber=field(fields,["DocumentNumber","IdNumber","IdentificationNumber","PersonalNumber"]);
  let number=fieldNumber?.replace(/[^0-9]/g,"")??"";
  if(!/^784\\d{12}$/.test(number)){
    const text=typeof analysis["content"]==="string"?analysis["content"]:"";
    number=text.match(/(?:^|[^0-9])(784[- ]?\\d{4}[- ]?\\d{7}[- ]?\\d)(?:$|[^0-9])/)?.[1]
      ?.replace(/[^0-9]/g,"")??"";
  }
  if(!/^784\\d{12}$/.test(number)||number.slice(-4)!==parsed.documentNumberLast4)
    throw new PersistenceError("CONFLICT","Invoice Emirates ID did not match extracted evidence");
  return {fullName:parsed.fullName,number,last4:parsed.documentNumberLast4};
}

function endpoint(){
  const raw=process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const key=process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
  if(!raw||!key||key.length<16)
    throw new PersistenceError("NOT_CONFIGURED","Azure identity OCR is not configured");
  let base:URL;
  try{base=new URL(raw);}catch{throw new PersistenceError("NOT_CONFIGURED","Invalid Azure OCR endpoint");}
  if(base.protocol!=="https:"||base.username||base.password||
     !base.hostname.endsWith(".cognitiveservices.azure.com") ||
     base.search||base.hash||!["","/"].includes(base.pathname))
    throw new PersistenceError("NOT_CONFIGURED","Azure OCR must use a dedicated HTTPS Cognitive Services endpoint");
  return {url:base.origin,key};
}
async function boundedResult(response:Response):Promise<unknown>{
  const body=await response.text();
  if(body.length>200000)throw new PersistenceError("CONFLICT","OCR result exceeded safety limits");
  try{return JSON.parse(body) as unknown;}
  catch{throw new PersistenceError("CONFLICT","OCR returned an invalid result");}
}
async function analyzeIdentityDocument(bytes:Buffer):Promise<unknown>{
  const config=endpoint();
  const url=config.url+"/documentintelligence/documentModels/prebuilt-idDocument:analyze?api-version=2024-11-30";
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),45000);
  try{
    const created=await fetch(url,{
      method:"POST",redirect:"error",signal:controller.signal,
      headers:{"Content-Type":"application/json","Ocp-Apim-Subscription-Key":config.key},
      body:JSON.stringify({base64Source:bytes.toString("base64")}),
    });
    if(created.status!==202)
      throw new PersistenceError("CONFLICT","Identity document OCR request was rejected");
    const operation=created.headers.get("operation-location");
    let target:URL;
    try{target=new URL(operation??"");}
    catch{throw new PersistenceError("CONFLICT","OCR operation location was missing");}
    if(target.origin!==config.url ||
       !/^\/documentintelligence\/documentModels\/prebuilt-idDocument\/analyzeResults\/[0-9a-f-]{36}$/i.test(target.pathname) ||
       target.searchParams.get("api-version")!=="2024-11-30")
      throw new PersistenceError("CONFLICT","OCR operation location was not trusted");
    for(let attempt=0;attempt<24;attempt++){
      await new Promise<void>(resolve=>setTimeout(resolve,1200));
      const response=await fetch(target.href,{
        redirect:"error",signal:controller.signal,
        headers:{"Ocp-Apim-Subscription-Key":config.key},
      });
      if(!response.ok)throw new PersistenceError("CONFLICT","Identity OCR verification failed");
      const result=await boundedResult(response);
      const status=obj(result)["status"];
      if(status==="succeeded")return result;
      if(status==="failed")throw new PersistenceError("CONFLICT","Identity OCR could not read the document");
      if(status!=="running"&&status!=="notStarted")
        throw new PersistenceError("CONFLICT","Unexpected OCR state");
    }
    throw new PersistenceError("CONFLICT","Identity document extraction timed out");
  }catch(err){
    if(err instanceof PersistenceError)throw err;
    throw new PersistenceError("CONFLICT","Identity OCR unavailable; no document accepted");
  }finally{clearTimeout(timeout);}
}

/** Existing upload path retains only a name and last four characters. */
export async function extractIdentityDocument(bytes:Buffer,kind:IdentityKind):Promise<ExtractedIdentity>{
  return parseIdentityResult(await analyzeIdentityDocument(bytes),kind,allowUnnamedSyntheticPassport());
}
/** Re-reads already authorized private document bytes during TEST invoice
 * rendering. Does not retain the full number beyond the protected PDF. */
export async function extractInvoiceEmiratesId(bytes:Buffer):Promise<{fullName:string;number:string;last4:string}>{
  return parseInvoiceEmiratesId(await analyzeIdentityDocument(bytes));
}
