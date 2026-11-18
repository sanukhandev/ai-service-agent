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
  confirmed:boolean;readyForOtp:boolean;reviewIssued?:boolean;
  renewalAgreementNumber?:string|null;
}
interface Challenge {
  challengeId:string;quotationId:string;state:string;expiresAt:string;
}
interface Payment {
  id:string;state:string;orderReference:string|null;providerPaymentId:string|null;
  checkoutUrl:string|null;providerStatus?:string|null;
}
interface Invoice {
  id:string;state:string;documentNumber:string;pdfAvailable:boolean;
  agreementNumber?:string;revision?:number;syncState?:string;
}
interface Summary {
  enabled:boolean;payments:Payment[];invoice:Invoice|null;
  contract:Invoice|null;
}
interface Journey {
  lead:{state:string}|null;
  quotation:Quote|null;
  quoteConfirmation:{
    verified:boolean;contactEmail:string|null;
    challenge:{challengeId:string;state:string;expiresAt:string}|null;
  }|null;
  purchase:Purchase;
  otp:Challenge|null;
  payment:Summary|null;
}

const RENEWAL_START_CONSENT =
  "I request a fresh ANCFZ sandbox renewal quotation and authorize reusing my previously recorded company details, verified Salesforce enquiry reference and privately stored synthetic identity documents for this agreement renewal. I understand a new payment and invoice are required.";

function safeCheckoutUrl(value:string|null):value is string{
  if(!value)return false;
  try{
    const url=new URL(value);
    return url.protocol==="https:" && url.hostname==="mockgateway.com" &&
      /^\/pg\/pay\/[A-Za-z0-9_-]{1,120}$/.test(url.pathname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash;
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
  // Filename and browser MIME metadata can be unreliable; the API validates
  // actual document bytes and accepts only PDF, PNG and JPEG signatures.
  if(file.size<100||file.size>1048576)
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

export function ChatJourneyControls({
  ticketId,revision,onContinuePurchase,onDocumentsUpdated,onTransactionStateChange,onRenewalCreated,conversationBusy,
}:{
  ticketId:string;revision:number;
  onContinuePurchase:()=>Promise<void>;onDocumentsUpdated:()=>void;
  onTransactionStateChange:(status:string|null)=>void;
  onRenewalCreated:(newTicketId:string)=>void;
  conversationBusy:boolean;
}){
  const [data,setData]=useState<Journey|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [otp,setOtp]=useState("");
  const [orderReference,setOrderReference]=useState("");
  const [providerPaymentId,setProviderPaymentId]=useState("");
  const [editingDocuments,setEditingDocuments]=useState(false);
  const [modalOpen,setModalOpen]=useState(false);
  const [quoteCode,setQuoteCode]=useState("");
  const [renewalConsent,setRenewalConsent]=useState(false);
  const renewalRequest=useRef<string|null>(null);
  const [uploadStage,setUploadStage]=useState<string|null>(null);
  const quoteRequest=useRef<string|null>(null);
  const autoOpenedQuote=useRef<string|null>(null);
  const otpRequest=useRef<string|null>(null);
  const reviewRequestedForQuote=useRef<string|null>(null);
  const checkoutPopup=useRef<Window|null>(null);
  const checkoutWatcher=useRef<ReturnType<typeof setInterval>|null>(null);
  const [fallbackCheckoutUrl,setFallbackCheckoutUrl]=useState<string|null>(null);
  useEffect(()=>()=>{if(checkoutWatcher.current)clearInterval(checkoutWatcher.current);},[]);

  const root="/api/v1/tickets/"+encodeURIComponent(ticketId);
  const load=useCallback(async()=>{
    const response=await requestJson<Journey>(root+"/chat-journey");
    setData(response);
    return response;
  },[root]);
  useEffect(()=>{
    let live=true;
    void requestJson<Journey>(root+"/chat-journey")
      .then(result=>{if(live)setData(result);})
      .catch(()=>{if(live)setData(null);});
    return ()=>{live=false;};
  },[root,revision]);
  // Treat the quote confirmation as a separate step from the later payment OTP.
  useEffect(()=>{
    const quote=data?.quotation;
    if(quote?.state==="verified_completed"&&quote.pdfAvailable &&
       data?.quoteConfirmation&&!data.quoteConfirmation.verified &&
       autoOpenedQuote.current!==quote.id){
      autoOpenedQuote.current=quote.id;
      setModalOpen(true);
    }
  },[data?.quotation,data?.quoteConfirmation]);

  const activeStage=(()=>{
    const leadState=data?.lead?.state;
    if(leadState && ["queued","running","creating"].includes(leadState))
      return "Sara is submitting and verifying your Salesforce enquiry…";
    const quoteState=data?.quotation?.state;
    if(quoteState && ["queued","running","creating"].includes(quoteState))
      return "Sara is preparing and verifying the formal quotation…";
    const payment=data?.payment?.payments?.[0];
    if(payment && ["queued","creating","verifying"].includes(payment.state))
      return "Sara is checking the sandbox order with the gateway…";
    return null;
  })();
  useEffect(()=>{
    onTransactionStateChange(uploadStage??
      (busy?busy.startsWith("upload:")?"Reading and validating your synthetic document…":
        "Completing the secure transaction step…":activeStage));
  },[onTransactionStateChange,uploadStage,busy,activeStage]);
  useEffect(()=>{
    if(!modalOpen)return;
    function handleEscape(event:KeyboardEvent){
      if(event.key==="Escape")setModalOpen(false);
    }
    document.addEventListener("keydown",handleEscape);
    return ()=>document.removeEventListener("keydown",handleEscape);
  },[modalOpen]);

  async function startAgreementRenewal(){
    const agreementNumber=data?.payment?.contract?.agreementNumber;
    if(!agreementNumber||!data?.payment?.contract?.pdfAvailable||
       !renewalConsent||busy!==null)return;
    setBusy("renewal");setError(null);setNotice(null);
    const requestId=renewalRequest.current??crypto.randomUUID();
    renewalRequest.current=requestId;
    try{
      const result=await requestJson<{ticketId:string;agreementNumber:string}>(
        root+"/agreements/renew",{
          requestId,agreementNumber,consent:true,
          consentText:RENEWAL_START_CONSENT,
        });
      if(result.agreementNumber!==agreementNumber||!result.ticketId)
        throw Error("Unexpected renewal response");
      renewalRequest.current=null;
      onRenewalCreated(result.ticketId);
    }catch(e){
      setError(e instanceof Error?e.message:"Could not start the agreement renewal");
    }finally{setBusy(null);}
  }

  async function requestQuoteOtp(){
    const quote=data?.quotation;
    const email=data?.quoteConfirmation?.contactEmail;
    if(!quote||!email||busy)return;
    setBusy("quote-otp-request");setError(null);setNotice(null);
    const requestId=quoteRequest.current??crypto.randomUUID();
    quoteRequest.current=requestId;
    try{
      await requestJson(root+"/quotations/confirmation/otp",{
        requestId,quotationId:quote.id,confirmedEmail:email,
      });
      quoteRequest.current=null;
      setNotice("A synthetic quote-confirmation code was recorded in the sandbox test table. Enter it securely here; do not send it to Sara.");
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:"Could not record quote OTP");
      const latest=await load().catch(()=>null);
      // A definitively failed/expired challenge may be re-requested after
      // the server cooldown. An uncertain POST outcome retains its request ID
      // and is NEVER blindly replayed as a new OTP.
      if(latest?.quoteConfirmation?.challenge &&
         ["failed","expired"].includes(latest.quoteConfirmation.challenge.state))
        quoteRequest.current=null;
    }finally{setBusy(null);}
  }

  async function verifyQuoteOtp(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const quote=data?.quotation;
    const challenge=data?.quoteConfirmation?.challenge;
    if(!quote||!challenge||busy||!/^[0-9]{6}$/.test(quoteCode))return;
    setBusy("quote-otp-verify");setError(null);setNotice(null);
    try{
      await requestJson(root+"/quotations/confirmation/verify",{
        quotationId:quote.id,challengeId:challenge.challengeId,code:quoteCode,
      });
      setQuoteCode("");
      setNotice("Quote confirmation verified. The synthetic identity document step is now available.");
      await load();
      onDocumentsUpdated();
    }catch(e){
      setQuoteCode("");
      setError(e instanceof Error?e.message:"Quote OTP could not be verified");
      await load().catch(()=>{});
    }finally{setBusy(null);}
  }


  // Reconcile old tickets whose documents were already complete before the
  // upload-triggered Node review existed. A POST creates a review message only;
  // it never consents to or dispatches a sandbox purchase.
  useEffect(()=>{
  const quote=data?.quotation;
    const purchase=data?.purchase;
    if(!quote||quote.state!=="verified_completed"||!quote.pdfAvailable||
       !purchase?.supported||purchase.confirmed||purchase.reviewIssued!==false||
       purchase.missing.length!==0||conversationBusy||
       purchase.documents.filter(d=>d.key==="passport"||d.key==="emirates_id")
         .filter(d=>d.uploaded).length!==2||
       reviewRequestedForQuote.current===quote.id)return;
    reviewRequestedForQuote.current=quote.id;
    void requestJson<{created:boolean}>(root+"/chat-journey/review",{})
      .then(async()=>{
        await load();
        onDocumentsUpdated();
      })
      .catch(e=>{
        setError(e instanceof Error?e.message:"Unable to show the purchase review");
      });
  },[data,root,load,conversationBusy,onDocumentsUpdated]);

  async function upload(key:string,file:File|undefined){
    if(!file||busy)return;
    if(!data?.quoteConfirmation?.verified){
      setError("Confirm the quotation using the secure OTP before uploading documents.");
      return;
    }
    setBusy("upload:"+key);setUploadStage("Reading and checking the selected file…");
    setError(null);setNotice(null);setModalOpen(true);
    try{
      const dataBase64=await base64File(file);
      setUploadStage("Uploading securely and extracting document details with OCR…");
      await requestJson(root+"/purchase/documents",{
        requirementKey:key,fileName:file.name,contentType:file.type,dataBase64,
      });
      setUploadStage("Document received. Checking remaining requirements…");
      const updated=await load();
      onDocumentsUpdated();
      if(updated.purchase.missing.length===0){
        setEditingDocuments(false);
        setNotice(null);
      }else{
        setNotice("Synthetic document received securely. Its contents are not part of the chat transcript.");
      }
    }catch(e){setError(e instanceof Error?e.message:"Unable to upload document");}
    finally{setBusy(null);setUploadStage(null);}
  }

  async function continuePurchase(){
    if(busy!==null||conversationBusy)return;
    setBusy("purchase");setError(null);setNotice(null);
    try{
      // Use the existing customer-message path. This is a REQUEST, never
      // payment authorization, and cannot bypass the server's quote/OTP gates.
      await onContinuePurchase();
    }catch(e){
      setError(e instanceof Error?e.message:"Unable to request purchase review");
    }finally{setBusy(null);}
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

  async function renewPaymentOtp(){
    if(busy!==null)return;
    setBusy("renew-otp");setError(null);setNotice(null);setOtp("");
    try{
      await requestJson(root+"/payments/otp/renew",{requestId:crypto.randomUUID()});
      await load();
      setNotice("A fresh synthetic OTP has been recorded privately. Enter the new code securely in this chat. Your quotation and documents were not reset.");
    }catch(e){
      setError(e instanceof Error?e.message:"A fresh OTP could not be requested");
    }finally{setBusy(null);}
  }

  async function reconcileOrder(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const payment=data?.payment?.payments?.[0];
    if(!payment||payment.state!=="unknown_outcome"||payment.orderReference||
       busy!==null||!/^[A-Za-z0-9_-]{1,120}$/.test(orderReference.trim())||
       !/^[A-Za-z0-9_-]{1,120}$/.test(providerPaymentId.trim()))return;
    setBusy("reconcile");setError(null);setNotice(null);
    try{
      await requestJson(root+"/payments/"+encodeURIComponent(payment.id)+"/reconcile",{
        orderReference:orderReference.trim(),providerPaymentId:providerPaymentId.trim(),
      });
      setOrderReference("");setProviderPaymentId("");
      setNotice("Existing gateway order matched. Payment remains unverified until a fresh gateway status check.");
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:"Gateway order could not be reconciled");
    }finally{setBusy(null);}
  }

  // A popup must be created synchronously during the user click. Fetching
  // the existing checkout link first would trigger browser popup blockers.
  // Popup close is NOT payment evidence; a separate server-side GET is required.
  async function verifyAfterCheckoutClose(paymentId:string){
    setBusy("verify");setError(null);setNotice("Checking the gateway after checkout closed…");
    try {
      const result=await requestJson<Summary>(
        root+"/payments/"+encodeURIComponent(paymentId)+"/checkout-closed",{});
      await load();
      onDocumentsUpdated(); // Refresh durable assistant messages and SSE snapshot.
      const state=result.payments.find(p=>p.id===paymentId)?.state??"unknown_outcome";
      setNotice(state==="verified_test_payment"
        ?"The gateway independently confirmed COMPLETE. Sara is preparing your TEST invoice and service contract."
        :state==="payment_pending"
          ?"The gateway still reports PENDING. You can reopen the existing checkout; no invoice has been issued."
          :state==="payment_declined"||state==="payment_refunded"
            ?"Gateway status: "+state.replaceAll("_"," ")+". You can request a new OTP after a confirmed decline; no new order was created."
            :"Payment is not yet confirmed. Sara will keep checking the gateway automatically; no invoice has been issued.");
    }catch(e){
      setError(e instanceof Error?e.message:"Unable to verify the existing checkout");
      setNotice("Checkout window closed. No payment is assumed complete.");
      await load().catch(()=>{});
      onDocumentsUpdated();
    }finally{setBusy(null);}
  }

  async function reopenCheckout(){
    const payment=data?.payment?.payments?.[0];
    if(!payment||!payment.orderReference||!payment.providerPaymentId||
       !["checkout_available","order_created_checkout_unavailable","payment_pending"].includes(payment.state)||
       busy!==null||checkoutWatcher.current)return;
    setBusy("checkout");setError(null);setNotice(null);setFallbackCheckoutUrl(null);
    const popup=window.open("about:blank","_blank",
      "popup=yes,width=540,height=740,scrollbars=yes,resizable=yes");
    if(popup){
      // Prevent the cross-origin payment page from controlling Sara.
      // Document access is only optional presentation, never authorization.
      try{
        popup.document.title="Existing sandbox checkout";
        popup.document.body.textContent="Checking the existing sandbox order…";
        popup.opener=null;
      }catch{/* Browser isolation may disallow modifying the blank window. */}
    }
    try {
      const result=await requestJson<{
        checkoutUrl:string;paymentId:string;orderReference:string;
        existingOrder:boolean;newOrderCreated:boolean;providerStatus:string;
      }>(root+"/payments/"+encodeURIComponent(payment.id)+"/checkout-link",{});
      if(result.paymentId!==payment.id||result.orderReference!==payment.orderReference||
         result.existingOrder!==true||result.newOrderCreated!==false||
         result.providerStatus!=="PENDING"||!safeCheckoutUrl(result.checkoutUrl)||
         new URL(result.checkoutUrl).pathname!=="/pg/pay/"+payment.providerPaymentId)
        throw Error("Gateway returned an untrusted existing checkout link");
      setFallbackCheckoutUrl(result.checkoutUrl);
      await load();
      onDocumentsUpdated();
      if(popup&&!popup.closed){
        popup.location.replace(result.checkoutUrl);
        popup.focus();
        checkoutPopup.current=popup;
        checkoutWatcher.current=setInterval(()=>{
          if(!popup.closed)return;
          if(checkoutWatcher.current)clearInterval(checkoutWatcher.current);
          checkoutWatcher.current=null;checkoutPopup.current=null;
          void verifyAfterCheckoutClose(payment.id);
        },750);
        setNotice("Existing sandbox checkout opened in a small window. Closing it will trigger an independent payment status check.");
      }else{
        setNotice("The checkout window was blocked or closed. Use the secure checkout link below. Sara will check payment status automatically.");
      }
    }catch(e){
      if(popup&&!popup.closed)popup.close();
      setError(e instanceof Error?e.message:"Could not reopen the existing payment");
      setFallbackCheckoutUrl(null);
    }finally{setBusy(null);}
  }

  const quote=data?.quotation;
  const quoteVerified=quote?.state==="verified_completed" && quote.pdfAvailable===true;
  const purchase=data?.purchase;
  const challenge=data?.otp;
  const currentPayment=data?.payment?.payments?.[0]??null;
  const invoice=data?.payment?.invoice??null;
  const contract=data?.payment?.contract??null;
  const quoteOtpConfirmed=data?.quoteConfirmation?.verified===true;
  const quoteOtpChallenge=data?.quoteConfirmation?.challenge??null;
  // A quote is the only entry to the secure purchase controls; no document
  // intake is offered before independently validated PDF evidence.
  if(!quoteVerified || !quote)return null;
  const documents=purchase?.supported && !purchase.confirmed
    ? purchase.documents.filter(d=>["passport","emirates_id"].includes(d.key))
    : [];
  const documentsComplete=Boolean(
    purchase?.supported && !purchase.confirmed && documents.length===2 &&
    purchase.missing.length===0 && documents.every(doc=>doc.uploaded),
  );
  const showOtp=Boolean(
    (!currentPayment || currentPayment.state==="payment_declined") &&
    challenge?.state==="mock_recorded" &&
    challenge.quotationId===quote.id && new Date(challenge.expiresAt).getTime()>Date.now(),
  );

  return (
    <div className="mt-5" aria-label="Secure in-chat journey">
      <button type="button" onClick={()=>setModalOpen(true)}
        className="flex w-full max-w-xl items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-white p-4 text-left text-sm shadow-sm hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-indigo-600">
        <span>
          <strong className="block text-zinc-900">Secure transaction</strong>
          <span className="mt-1 block text-xs text-zinc-600">
            {quoteOtpConfirmed?"Quotation confirmed — manage synthetic documents and checkout":
              "Review your verified quotation and confirm with a private OTP"}
          </span>
        </span>
        <span className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white">
          {modalOpen?"Viewing":"Open"}
        </span>
      </button>
      {modalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-5"
          role="dialog" aria-modal="true" aria-labelledby="secure-transaction-title">
          <button type="button" aria-label="Close secure transaction overlay"
            onClick={()=>setModalOpen(false)}
            className="absolute inset-0 bg-zinc-950/60 backdrop-blur-sm"/>
          <div className="relative z-10 max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-5 text-sm shadow-2xl sm:p-7">
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2 id="secure-transaction-title" className="text-base font-semibold text-zinc-900">
                Sara · Secure transaction
              </h2>
              <button type="button" onClick={()=>setModalOpen(false)}
                autoFocus aria-label="Close secure transaction"
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100">
                Close
              </button>
            </div>
        <p className="font-medium">Verified quotation — {quote.currency} {quote.amount}</p>
        <a className="mt-1 inline-block text-sm font-medium text-indigo-700 underline"
          href={root+"/quotations/"+encodeURIComponent(quote.id)+"/pdf"}>
          Download {quote.documentNumber} PDF
        </a>
        {!quoteOtpConfirmed && (
          <div className="mt-5 space-y-3 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
            <h3 className="text-sm font-semibold text-zinc-900">Confirm this quotation</h3>
            <p className="text-xs leading-5 text-zinc-700">
              Confirm the contact email already provided in our conversation.
              This sandbox OTP is stored in the private test table; no real email is sent.
              Identity documents stay locked until the code is verified.
            </p>
            {data?.quoteConfirmation?.contactEmail ? (
              <p className="break-all text-sm font-medium text-zinc-900">
                {data.quoteConfirmation.contactEmail}
              </p>
            ) : (
              <p role="alert" className="text-xs text-amber-800">
                Sara needs to confirm the contact email from your conversation before requesting a code.
              </p>
            )}
            {quoteOtpChallenge?.state==="mock_recorded" &&
             new Date(quoteOtpChallenge.expiresAt).getTime()>Date.now() ? (
              <form onSubmit={verifyQuoteOtp} className="space-y-2">
                <label htmlFor="quote-confirmation-code" className="block text-xs font-medium">
                  Synthetic quotation confirmation OTP
                </label>
                <input id="quote-confirmation-code" type="password" inputMode="numeric"
                  autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}"
                  value={quoteCode} onChange={event=>setQuoteCode(event.currentTarget.value)}
                  disabled={busy!==null}
                  className="w-40 rounded-lg border border-zinc-300 px-3 py-2"/>
                <button type="submit" disabled={busy!==null||!/^[0-9]{6}$/.test(quoteCode)}
                  className="block rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  {busy==="quote-otp-verify"?"Verifying quotation…":"Verify quotation OTP"}
                </button>
              </form>
            ) : (
              <button type="button" onClick={()=>{void requestQuoteOtp();}}
                disabled={busy!==null||!data?.quoteConfirmation?.contactEmail}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">
                {busy==="quote-otp-request"?"Recording test code…":
                  "Confirm this email and request quote OTP"}
              </button>
            )}
            {quoteOtpChallenge && quoteOtpChallenge.state!=="mock_recorded" && (
              <p className="text-xs text-zinc-600">
                The previous code is no longer active. Request another after the cooldown.
              </p>
            )}
          </div>
        )}
        {quoteOtpConfirmed && (
          <p role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-900">
            Quotation OTP verified. Secure document collection is now unlocked.
          </p>
        )}
        {purchase?.supported && quoteOtpConfirmed && documents.length>0 && (
          <div className="mt-4 space-y-3">
            {documentsComplete && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-emerald-800" role="status">
                  Required synthetic documents received
                </p>
                {documents.some(doc=>doc.status==="synthetic_name_unverified") && (
                  <p className="text-xs text-amber-800">
                    POC only: the synthetic passport was classified, but its holder name
                    was not verified. The TEST invoice will use the Emirates ID name.
                    This is not identity verification.
                  </p>
                )}
                <p className="text-xs text-zinc-700">
                  {purchase.reviewIssued
                    ? "Sara's purchase review is available in the chat. Answer the requested billing question or review the exact-amount proposal before authorizing."
                    : "Checkout has not started. Sara is preparing the next purchase-review question; you can also request it using the button below."}
                  A test OTP, order and invoice require separate authorization and verified payment.
                </p>
                <button type="button" onClick={()=>{void continuePurchase();}}
                  disabled={busy!==null||conversationBusy}
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  {busy==="purchase"?"Requesting purchase review…":
                    purchase.reviewIssued?"Ask Sara to show purchase review again":"Continue to sandbox purchase review"}
                </button>
                <button type="button" onClick={()=>setEditingDocuments(value=>!value)}
                  disabled={busy!==null||conversationBusy}
                  className="ml-3 text-xs text-zinc-700 underline disabled:opacity-40">
                  {editingDocuments?"Hide document inputs":"Replace synthetic documents"}
                </button>
              </div>
            )}
            {(!documentsComplete||editingDocuments) && (
              <div className="space-y-3">
                <p className="font-medium">Upload your synthetic identity documents here</p>
                {uploadStage && (
                  <p role="status" aria-live="polite"
                    className="flex items-center gap-2 rounded-lg bg-indigo-50 p-3 text-xs font-medium text-indigo-900">
                    <span className="size-4 animate-spin rounded-full border-2 border-indigo-700 border-r-transparent"/>
                    {uploadStage}
                  </p>
                )}
                <p className="text-xs text-amber-800">
                  Development sandbox only. Never upload real identity documents on local HTTP.
                  Files go directly to a private Node endpoint, not to Sara's AI transcript.
                </p>
                {documents.map(doc=>(
                  <label key={doc.key} className="block rounded-lg border border-zinc-200 p-3">
                    <span className="block text-sm font-medium">
                      {doc.label}{doc.required?" (required)":""}
                    </span>
                    <span className="block text-xs text-zinc-600">
                      {doc.uploaded?"Uploaded — you may replace it before purchase consent":
                        "PDF, PNG or JPEG, max 1 MiB"}
                    </span>
                    <input className="mt-2 block w-full text-xs" type="file"
                      accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                      disabled={busy!==null||conversationBusy}
                      onChange={event=>{
                        const file=event.currentTarget.files?.[0];
                        event.currentTarget.value="";
                        void upload(doc.key,file);
                      }}/>
                  </label>
                ))}
                {purchase.missing.includes("identity_name_mismatch") && (
                  <p role="alert" className="text-xs text-red-700">
                    Extracted identity names do not match. Purchase and invoice are blocked.
                  </p>
                )}
              </div>
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
        {challenge && !showOtp && !currentPayment && purchase?.confirmed && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-amber-800">
              This test OTP is no longer usable. Request a fresh code; the original cannot be reused.
            </p>
            <button type="button" disabled={busy!==null}
              onClick={()=>{void renewPaymentOtp();}}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium disabled:opacity-40">
              {busy==="renew-otp"?"Requesting…":"Request new OTP"}
            </button>
          </div>
        )}
        {currentPayment && (
          <div className="mt-3 space-y-2">
            <p className="text-xs">Sandbox order: <strong>{currentPayment.state.replaceAll("_"," ")}</strong></p>
            {currentPayment.state==="payment_declined" && !showOtp && (
              <div className="space-y-2">
                <p className="text-xs text-amber-800">
                  The provider confirmed DECLINED. Your quotation and identity documents are retained.
                  A new sandbox link requires a fresh OTP; your old order will not be retried.
                </p>
                <button type="button" disabled={busy!==null}
                  onClick={()=>{void renewPaymentOtp();}}
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
                  {busy==="renew-otp"?"Requesting…":"Retry declined payment — request new OTP"}
                </button>
              </div>
            )}
            {currentPayment.orderReference && currentPayment.providerPaymentId &&
              ["checkout_available","order_created_checkout_unavailable","payment_pending"].includes(currentPayment.state) && (
              <div className="space-y-2">
                <button type="button" onClick={()=>{void reopenCheckout();}}
                  disabled={busy!==null||checkoutWatcher.current!==null}
                  className="inline-block rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  {busy==="checkout"?"Opening secure checkout…":
                   checkoutWatcher.current?"Checkout window open":
                   "Click to pay"}
                </button>
                {safeCheckoutUrl(fallbackCheckoutUrl) && (
                  <a href={fallbackCheckoutUrl} target="_blank" rel="noopener noreferrer nofollow"
                    className="block text-xs text-indigo-700 underline">
                    Open existing checkout in a new tab (popup fallback)
                  </a>
                )}
              </div>
            )}
            {currentPayment.state==="unknown_outcome" && (
              <div className="space-y-2">
                <p role="alert" className="text-xs text-amber-800">
                  Provider outcome unknown. Do not create another payment order.
                </p>
                {currentPayment.providerStatus && (
                  <p className="text-xs text-zinc-600">
                    Dispatch diagnostic: {currentPayment.providerStatus}
                  </p>
                )}
                {!currentPayment.orderReference && (
                  <form className="space-y-2" onSubmit={reconcileOrder}>
                    <label className="block text-xs font-medium" htmlFor="existing-gateway-order">
                      Existing MockGateway RefNo / OrderNo (operator recovery)
                    </label>
                    <input id="existing-gateway-order" autoComplete="off"
                      value={orderReference} onChange={event=>setOrderReference(event.currentTarget.value)}
                      maxLength={120} placeholder="Existing provider order number"
                      className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-xs"/>
                    <label className="block text-xs font-medium" htmlFor="existing-gateway-payment-id">
                      MockGateway transaction ID (for record matching, not GET lookup)
                    </label>
                    <input id="existing-gateway-payment-id" autoComplete="off"
                      value={providerPaymentId}
                      onChange={event=>setProviderPaymentId(event.currentTarget.value)}
                      maxLength={120} placeholder="Transaction ID from MockGateway dashboard"
                      className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-xs"/>
                    <p className="text-xs text-zinc-600">
                      Read-only gateway lookup uses the existing RefNo/OrderNo. Enter its matching
                      dashboard transaction ID for recovery tracking. No new order or OTP will be generated.
                    </p>
                    <button type="submit" disabled={busy!==null||
                      !/^[A-Za-z0-9_-]{1,120}$/.test(orderReference.trim())||
                      !/^[A-Za-z0-9_-]{1,120}$/.test(providerPaymentId.trim())}
                      className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">
                      {busy==="reconcile"?"Checking existing order…":"Reconcile existing order (GET only)"}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
        {contract?.pdfAvailable===true && (
          <div className="mt-4 space-y-3 rounded-xl border border-zinc-200 p-3">
            <p className="text-xs font-semibold text-zinc-900">
              Agreement {contract.agreementNumber??contract.documentNumber}
              {contract.revision?(" · Revision "+contract.revision):""}
            </p>
            <a href={root+"/contracts/"+encodeURIComponent(contract.id)+"/pdf"}
              className="inline-block text-sm font-semibold text-indigo-700 underline">
              Download your private TEST service agreement
            </a>
            {!purchase?.renewalAgreementNumber && (
              <>
                <label className="flex items-start gap-2 text-xs text-zinc-700">
                  <input type="checkbox" checked={renewalConsent}
                    onChange={e=>setRenewalConsent(e.target.checked)}
                    disabled={busy!==null} className="mt-0.5"/>
                  <span>{RENEWAL_START_CONSENT}</span>
                </label>
                <button type="button" disabled={busy!==null||!renewalConsent}
                  onClick={()=>{void startAgreementRenewal();}}
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
                  {busy==="renewal"?"Creating renewal…":"Renew this agreement"}
                </button>
              </>
            )}
          </div>
        )}
        {contract?.state==="needs_review" && (
          <p className="mt-3 text-xs text-amber-800">
            Payment verified. Private contract preparation needs identity-document review;
            no identity number has been fabricated.
          </p>
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
      )}
    </div>
  );
}
