/**
 * Azure Document Intelligence v4 ID-document extraction for the POC.
 * The submitted bytes are delivered only to the configured Azure endpoint.
 * Never persist raw OCR JSON, birth dates, full ID numbers or full MRZ text.
 * A recognized name is NOT identity or document authenticity verification.
 */
import { PersistenceError } from "../database/pool.js";

export type IdentityKind="passport"|"emirates_id";
export type ExtractedIdentity={
  fullName:string;
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
export function parseIdentityResult(raw:unknown,kind:IdentityKind):ExtractedIdentity{
  const result=obj(raw);
  const analysis=obj(result["analyzeResult"]);
  const docs=analysis["documents"];
  if(result["status"]!=="succeeded" || !Array.isArray(docs)||docs.length!==1)
    throw new PersistenceError("CONFLICT","Identity document could not be extracted");
  const doc=obj(docs[0]),fields=obj(doc["fields"]);
  const combined=field(fields,["FullName","FullNameEnglish","Name","NameEnglish","PersonName"]);
  const first=field(fields,["FirstName","GivenNames","GivenName","GivenNameEnglish"]);
  const last=field(fields,["LastName","Surname","FamilyName","SurnameEnglish"]);
  const fullName=normalizeBillingName(combined || [first,last].filter(Boolean).join(" "));
  if(fullName.length<3||fullName.length>200||fullName.split(" ").length<2||
     !/[\p{L}]/u.test(fullName)||
     /[^\p{L}\p{M}\p{N} .'’-]/u.test(fullName))
    throw new PersistenceError("CONFLICT",kind+" document did not yield a reliable full name");
  const number=field(fields,kind==="passport"
    ? ["DocumentNumber","PassportNumber","MachineReadableZone"]
    : ["DocumentNumber","IdNumber","IdentificationNumber","PersonalNumber"]);
  const normalizedNumber=number?.replace(/[^A-Za-z0-9]/g,"")??"";
  return {fullName,documentNumberLast4:normalizedNumber.length>=4
    ? normalizedNumber.slice(-4).toUpperCase():null,
    model:"prebuilt-idDocument"};
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
export async function extractIdentityDocument(bytes:Buffer,kind:IdentityKind):Promise<ExtractedIdentity>{
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
      if(status==="succeeded")return parseIdentityResult(result,kind);
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
