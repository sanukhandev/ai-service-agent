"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PurchaseChecklist } from "./purchase-checklist";

const consentText =
  "I authorize an ANCFZ sandbox payment for the exact quotation amount shown and understand that this is a test transaction.";

interface Quote {
  id:string;state:string;amount:string;currency:string;
  offeringLabel:string;documentNumber:string;pdfAvailable:boolean;
}
interface Payment {
  id:string;quotationId:string;state:string;amount:string;currency:string;
  orderReference:string|null;checkoutUrl:string|null;providerStatus:string|null;
}
interface Invoice {
  id:string;state:string;documentNumber:string;pdfAvailable:boolean;
}
type Summary={enabled:boolean;payments:Payment[];invoice:Invoice|null};
type Challenge={challengeId:string;quotationId:string;expiresAt:string;status:string};
function checkoutUrlSafe(value:string|null):value is string {
  if(!value)return false;
  try{
    const u=new URL(value);
    return u.protocol==="https:" && u.hostname==="mockgateway.com" &&
      u.pathname.startsWith("/pg/pay/") && !u.username && !u.password;
  }catch{return false;}
}
async function jsonRequest(path:string,method:"GET"|"POST",body?:object){
  const response=await fetch(path,{
    method,credentials:"include",cache:"no-store",
    headers:{Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  });
  const data=await response.json();
  if(!response.ok)throw Error(typeof data?.message==="string"?data.message:
    "The sandbox operation could not be completed");
  return data;
}
export function PaymentCheckout({ticketId,revision}:{ticketId:string;revision:number}) {
  const [summary,setSummary]=useState<Summary|null>(null);
  const [purchaseReady,setPurchaseReady]=useState(false);
  const [purchaseSupported,setPurchaseSupported]=useState(false);
  const [quote,setQuote]=useState<Quote|null>(null);
  const [challenge,setChallenge]=useState<Challenge|null>(null);
  const [firstName,setFirstName]=useState("Demo");
  const [email,setEmail]=useState("tester@example.invalid");
  const [code,setCode]=useState("");
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const otpRequestId=useRef<string|null>(null);
  const paymentRequestId=useRef<string|null>(null);

  useEffect(()=>{
    let live=true;
    async function load(){
      try {
        const [payment,quotation,purchase]=await Promise.all([
          jsonRequest("/api/v1/tickets/"+encodeURIComponent(ticketId)+"/payments","GET"),
          jsonRequest("/api/v1/tickets/"+encodeURIComponent(ticketId)+"/quotations","GET"),
          jsonRequest("/api/v1/tickets/"+encodeURIComponent(ticketId)+"/purchase","GET"),
        ]);
        if(!live)return;
        setSummary(payment as Summary);
        setQuote((quotation?.quotation??null) as Quote|null);
        setPurchaseSupported(purchase?.supported===true);
      }catch{/* Existing chat displays network/owner errors elsewhere. */}
    }
    void load();
    return ()=>{live=false;};
  },[ticketId,revision]);

  const payment=summary?.payments?.[0]??null;
  const quoteReady=quote?.state==="verified_completed" && quote.pdfAvailable;
  const ready=summary?.enabled===true && quoteReady && purchaseReady;
  if(!quoteReady&&!payment&&!purchaseSupported)return null;
  async function issueOtp(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!ready||!quote||busy||!consent)return;
    setBusy(true);setError(null);setNotice(null);
    const requestId=otpRequestId.current??crypto.randomUUID();
    otpRequestId.current=requestId;
    try{
      const result=await jsonRequest(
        "/api/v1/tickets/"+encodeURIComponent(ticketId)+"/payments/otp","POST",{
          requestId,quotationId:quote.id,acceptedAmount:quote.amount,currency:quote.currency,
          email,firstName,countryCode:"AE",consent:true,consentText,
        }) as Challenge;
      if(result.status!=="mock_recorded"||typeof result.challengeId!=="string")
        throw Error("Unexpected OTP recording response");
      setChallenge(result);
      setNotice("Synthetic OTP recorded in n8n ANCFZ_POC_OTPS. Retrieve it from the private n8n Data Table.");
      otpRequestId.current=null;
    }catch(e){setError(e instanceof Error?e.message:"Could not record test OTP");}
    finally{setBusy(false);}
  }
  async function authorize(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!challenge||!quote||busy||!consent||! /^\d{6}$/.test(code))return;
    setBusy(true);setError(null);
    const requestId=paymentRequestId.current??crypto.randomUUID();
    paymentRequestId.current=requestId;
    try{
      const result=await jsonRequest(
        "/api/v1/tickets/"+encodeURIComponent(ticketId)+"/payments/authorize","POST",{
          requestId,quotationId:quote.id,challengeId:challenge.challengeId,
          code,consent:true,consentText,
        });
      if(!result?.payment?.id)throw Error("Unexpected payment authorization response");
      setSummary(v=>({enabled:true,invoice:v?.invoice??null,payments:[result.payment]}));
      setChallenge(null);setCode("");paymentRequestId.current=null;
      setNotice("Sandbox order queued. This is not evidence of payment.");
    }catch(e){setError(e instanceof Error?e.message:"OTP validation failed");setCode("");}
    finally{setBusy(false);}
  }
  async function verify(){
    if(!payment||busy)return;
    setBusy(true);setError(null);setNotice(null);
    try{
      const result=await jsonRequest(
        "/api/v1/tickets/"+encodeURIComponent(ticketId)+"/payments/"+
        encodeURIComponent(payment.id)+"/verify","POST");
      setSummary(result as Summary);
      const state=(result as Summary).payments[0]?.state;
      setNotice(state==="verified_test_payment"
        ?"Matching sandbox COMPLETE status confirmed. TEST invoice is being generated."
        :"Gateway status: "+String(state??"unavailable")+". No paid invoice unless independently verified.");
    }catch(e){setError(e instanceof Error?e.message:"Payment status unavailable");}
    finally{setBusy(false);}
  }
  const invoice=summary?.invoice;
  return <section className="mb-3 rounded-xl border border-indigo-200 bg-white p-4 text-sm"
    aria-label="ANCFZ sandbox payment">
    <h2 className="font-semibold text-slate-900">ANCFZ identity documents and sandbox checkout</h2>
    <p className="mt-1 text-xs text-amber-800">
      Development simulation only. No real money, card or production customer OTPs.
    </p>
    {quote&&<p className="mt-2 text-xs text-slate-600">
      Approved quote {quote.documentNumber}: {quote.currency} {quote.amount} · {quote.offeringLabel}
    </p>}
    {!payment && purchaseSupported &&
      <PurchaseChecklist ticketId={ticketId} quote={quoteReady?quote:null} onReady={setPurchaseReady} revision={revision}/>}
    {error&&<p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
    {notice&&<p role="status" className="mt-2 text-xs text-indigo-800">{notice}</p>}
    {!payment && ready && !challenge && <form onSubmit={issueOtp} className="mt-3 space-y-3">
      <label className="block text-xs font-medium">Synthetic first name
        <input required maxLength={100} value={firstName} onChange={e=>setFirstName(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"/>
      </label>
      <label className="block text-xs font-medium">Synthetic test email (example.invalid only)
        <input required type="email" value={email} onChange={e=>setEmail(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"/>
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" required checked={consent}
          onChange={e=>setConsent(e.target.checked)} className="mt-0.5"/>
        <span>{consentText}</span>
      </label>
      <button type="submit" disabled={busy||!consent}
        className="rounded-lg bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {busy?"Recording…":"Record synthetic OTP in n8n"}
      </button>
    </form>}
    {!payment && challenge && <form onSubmit={authorize} className="mt-3 space-y-2">
      <p className="text-xs text-slate-700">Read the six-digit code from the private
        n8n Data Table. Expires: {new Date(challenge.expiresAt).toLocaleTimeString()}.</p>
      <label className="block text-xs font-medium">Test OTP
        <input required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}"
          maxLength={6} type="text" value={code} onChange={e=>setCode(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"/>
      </label>
      <button type="submit" disabled={busy||!consent||!/^\d{6}$/.test(code)}
        className="rounded-lg bg-indigo-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
        {busy?"Authorizing…":"Authorize exact sandbox amount"}
      </button>
    </form>}
    {payment&&<div className="mt-3 space-y-2 text-xs">
      <p>Payment attempt: <strong>{payment.state.replaceAll("_"," ")}</strong>
        {payment.orderReference?" · Order "+payment.orderReference:""}</p>
      {checkoutUrlSafe(payment.checkoutUrl)&&
        <a href={payment.checkoutUrl} target="_blank" rel="noopener noreferrer"
          className="inline-flex rounded-lg bg-indigo-700 px-3 py-2 font-semibold text-white">
          Open 2Checkout test payment
        </a>}
      {payment.orderReference&&<button type="button" disabled={busy} onClick={()=>void verify()}
        className="ml-2 rounded-lg border border-indigo-300 px-3 py-2 font-medium text-indigo-800 disabled:opacity-50">
        {busy?"Checking…":"Verify status with gateway"}
      </button>}
      {payment.state==="unknown_outcome"&&<p className="text-amber-800">
        Provider outcome uncertain. Do not create another order without reconciling this attempt.
      </p>}
    </div>}
    {invoice?.pdfAvailable&&<a
      href={"/api/v1/tickets/"+encodeURIComponent(ticketId)+"/invoices/"+
        encodeURIComponent(invoice.id)+"/pdf"}
      className="mt-3 inline-flex text-xs font-semibold text-indigo-700 underline">
      Download TEST invoice {invoice.documentNumber}
    </a>}
  </section>;
}
