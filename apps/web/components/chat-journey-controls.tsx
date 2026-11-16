"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

/** Secure ticket-owned inputs in the chat transcript, not in the message
 * composer. Identity files and OTP codes never reach Foundry or chat logs. */
interface Quote {
  id:string;state:string;amount:string;currency:string;
  documentNumber:string;pdfAvailable:boolean;
}
interface Document {
  key:string;label:string;required:boolean;uploaded:boolean;status:string;
}
interface Purchase {
  supported:boolean;quotationId:string|null;amount:string|null;
  currency:string|null;documents:Document[];missing:string[];
  confirmed:boolean;readyForOtp:boolean;
}
interface Challenge {
  challengeId:string;quotationId:string;state:string;expiresAt:string;
}
interface Payment {
  id:string;state:string;orderReference:string|null;checkoutUrl:string|null;
}
interface Invoice {
  id:string;state:string;documentNumber:string;pdfAvailable:boolean;
}
interface Summary {
  enabled:boolean;payments:Payment[];invoice:Invoice|null;
}
interface Journey {
  quotation:Quote|null;
  purchase:Purchase;
  otp:Challenge|null;
  payment:Summary|null;
}

const allowedTypes=["application/pdf","image/png","image/jpeg"];
function safeCheckoutUrl(value:string|null):value is string{
  if(!value)return false;
  try{
    const url=new URL(value);
    return url.protocol==="https:" && url.hostname==="mockgateway.com" &&
      url.pathname.startsWith("/pg/pay/") && !url.username && !url.password;
  }catch{return false;}
}
async function requestJson<T>(path:string,body?:object):Promise<T>{
  const response=await fetch(path,{
    method:body?"POST":"GET",cache:"no-store",credentials:"include",
    headers:{Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  });
  let result:unknown;
  try{result=await response.json();}catch{throw Error("Unexpected response from the service");}
  if(!response.ok){
    const detail=result as {message?:unknown};
    throw Error(typeof detail?.message==="string"?detail.message:"The secure operation was rejected");
  }
  return result as T;
}
async function base64File(file:File):Promise<string>{
  if(!allowedTypes.includes(file.type)||file.size<100||file.size>1048576)
    throw Error("Choose a PDF, PNG or JPEG between 100 bytes and 1 MiB");
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(Error("Unable to read selected document"));
    reader.onload=()=>{
      const data=String(reader.result);
      const encoded=data.split(",")[1];
      if(!encoded)reject(Error("Unable to encode document"));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

export function ChatJourneyControls({ticketId,revision}:{ticketId:string;revision:number}){
  const [data,setData]=useState<Journey|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [otp,setOtp]=useState("");
  const otpRequest=useRef<string|null>(null);
  const root="/api/v1/tickets/"+encodeURIComponent(ticketId);
  const load=useCallback(async()=>{
    const response=await requestJson<Journey>(root+"/chat-journey");
    setData(response);
  },[root]);
  useEffect(()=>{
    let live=true;
    void requestJson<Journey>(root+"/chat-journey")
      .then(result=>{if(live)setData(result);})
      .catch(()=>{if(live)setData(null);});
    return ()=>{live=false;};
  },[root,revision]);

  async function upload(key:string,file:File|undefined){
    if(!file||busy)return;
    setBusy("upload:"+key);setError(null);setNotice(null);
    try{
      const dataBase64=await base64File(file);
      await requestJson(root+"/purchase/documents",{
        requirementKey:key,fileName:file.name,contentType:file.type,dataBase64,
      });
      setNotice("Synthetic document received securely. Its contents are not part of the chat transcript.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Unable to upload document");}
    finally{setBusy(null);}
  }

  async function verifyOtp(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!data?.otp || !/^\d{6}$/.test(otp)||busy)return;
    setBusy("otp");setError(null);setNotice(null);
    const requestId=otpRequest.current??crypto.randomUUID();
    otpRequest.current=requestId;
    try{
      await requestJson(root+"/chat-journey/otp/verify",{
        requestId,challengeId:data.otp.challengeId,code:otp,
      });
      otpRequest.current=null;
      setOtp("");
      setNotice("Test OTP verified. A sandbox order has been queued; payment is not yet complete.");
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:"OTP was not verified");
      setOtp("");
    }finally{setBusy(null);}
  }

  const quote=data?.quotation;
  const quoteVerified=quote?.state==="verified_completed" && quote.pdfAvailable===true;
  const purchase=data?.purchase;
  const challenge=data?.otp;
  const currentPayment=data?.payment?.payments?.[0]??null;
  const invoice=data?.payment?.invoice??null;
  // A quote is the only entry to the secure purchase controls; no document
  // intake is offered before independently validated PDF evidence.
  if(!quoteVerified || !quote)return null;
  const documents=purchase?.supported && !purchase.confirmed
    ? purchase.documents.filter(d=>["passport","emirates_id"].includes(d.key))
    : [];
  const showOtp=Boolean(
    !currentPayment && challenge?.state==="mock_recorded" &&
    challenge.quotationId===quote.id && new Date(challenge.expiresAt).getTime()>Date.now(),
  );

  return (
    <div className="mt-5 flex items-start gap-3" aria-label="Secure in-chat journey">
      <div className="min-w-0 flex-1 rounded-2xl border border-zinc-200 bg-white p-4 text-sm shadow-sm">
        <div className="mb-2 text-xs font-semibold text-zinc-600">Sara · Secure transaction</div>
        <p className="font-medium">Verified quotation — {quote.currency} {quote.amount}</p>
        <a className="mt-1 inline-block text-sm font-medium text-indigo-700 underline"
          href={root+"/quotations/"+encodeURIComponent(quote.id)+"/pdf"}>
          Download {quote.documentNumber} PDF
        </a>
        {purchase?.supported && documents.length>0 && (
          <div className="mt-4 space-y-3">
            <p className="font-medium">Upload your synthetic identity documents here</p>
            <p className="text-xs text-amber-800">
              Development sandbox only. Never upload real identity documents on local HTTP.
              Files go directly to a private Node endpoint, not to Sara's AI transcript.
            </p>
            {documents.map(doc=>(
              <label key={doc.key} className="block rounded-lg border border-zinc-200 p-3">
                <span className="block text-sm font-medium">{doc.label}{doc.required?" (required)":""}</span>
                <span className="block text-xs text-zinc-600">
                  {doc.uploaded?"Uploaded — you may replace it before purchase consent":"PDF, PNG or JPEG, max 1 MiB"}
                </span>
                <input className="mt-2 block w-full text-xs" type="file"
                  accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                  disabled={busy!==null}
                  onChange={event=>{
                    const file=event.currentTarget.files?.[0];
                    event.currentTarget.value="";
                    void upload(doc.key,file);
                  }}/>
              </label>
            ))}
            {documents.some(doc=>doc.status==="synthetic_name_unverified") && (
              <p role="status" className="text-xs text-amber-800">
                POC only: this synthetic passport was classified by OCR, but no reliable
                passport holder name was extracted. The TEST invoice will use the
                Emirates ID holder name. This is not identity verification.
              </p>
            )}
            {purchase.missing.length===0 && (
              <p className="text-xs text-emerald-800">
                Required synthetic documents received. Tell Sara that you want to
                proceed with the sandbox purchase; she will show the exact amount
                and ask for conversational consent.
              </p>
            )}
            {purchase.missing.includes("identity_name_mismatch") && (
              <p role="alert" className="text-xs text-red-700">
                Extracted identity names do not match. Purchase and invoice are blocked.
              </p>
            )}
          </div>
        )}
        {purchase?.confirmed && !currentPayment && (
          <p className="mt-3 text-xs text-zinc-700">
            Sandbox purchase authorized. A synthetic OTP is required before the test order.
          </p>
        )}
        {showOtp && (
          <form className="mt-3 space-y-2" onSubmit={verifyOtp}>
            <label className="block text-xs font-medium" htmlFor="secure-chat-otp">
              Enter synthetic OTP securely (not in your message)
            </label>
            <input id="secure-chat-otp" type="password" inputMode="numeric"
              autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}"
              value={otp} onChange={event=>setOtp(event.currentTarget.value)}
              className="w-40 rounded-lg border border-zinc-300 px-3 py-2"/>
            <button type="submit" disabled={busy!==null||!/^\d{6}$/.test(otp)}
              className="block rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
              {busy==="otp"?"Verifying…":"Verify test OTP"}
            </button>
          </form>
        )}
        {challenge?.state==="mock_recorded" && !showOtp && !currentPayment && (
          <p className="mt-3 text-xs text-amber-800">
            The test OTP is no longer valid or has expired. Do not resend the
            original authorization; contact the service team for reconciliation.
          </p>
        )}
        {currentPayment && (
          <div className="mt-3 space-y-2">
            <p className="text-xs">Sandbox order: <strong>{currentPayment.state.replaceAll("_"," ")}</strong></p>
            {safeCheckoutUrl(currentPayment.checkoutUrl) && (
              <a href={currentPayment.checkoutUrl} target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-block rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white">
                Open hosted sandbox checkout
              </a>
            )}
            {currentPayment.state==="unknown_outcome" && (
              <p role="alert" className="text-xs text-amber-800">
                Provider outcome unknown. Do not create another payment order.
              </p>
            )}
          </div>
        )}
        {invoice?.pdfAvailable===true && (
          <a href={root+"/invoices/"+encodeURIComponent(invoice.id)+"/pdf"}
            className="mt-3 inline-block text-sm font-semibold text-indigo-700 underline">
            Download verified TEST invoice {invoice.documentNumber}
          </a>
        )}
        {error && <p role="alert" className="mt-3 text-xs text-red-700">{error}</p>}
        {notice && <p role="status" className="mt-3 text-xs text-zinc-700">{notice}</p>}
      </div>
    </div>
  );
}
