"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircleIcon, CheckIcon, DownloadIcon, FileTextIcon, RefreshCwIcon, ShieldCheckIcon, SparklesIcon } from "./icons";

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
  ticketId,revision,onContinuePurchase,onDocumentsUpdated,onTransactionStateChange,conversationBusy,
}:{
  ticketId:string;revision:number;
  onContinuePurchase:()=>Promise<void>;onDocumentsUpdated:()=>void;
  onTransactionStateChange:(status:string|null)=>void;
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
  const [uploadStage,setUploadStage]=useState<string|null>(null);
  const quoteRequest=useRef<string|null>(null);
  const autoOpenedQuote=useRef<string|null>(null);
  const autoOpenedQuoteOtp=useRef<string|null>(null);
  const autoOpenedDocuments=useRef<string|null>(null);
  const autoOpenedPaymentOtp=useRef<string|null>(null);
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
  // 1. Auto-open modal when a verified quotation is ready to review/confirm
  useEffect(()=>{
    const quote=data?.quotation;
    if(quote?.state==="verified_completed"&&quote.pdfAvailable &&
       data?.quoteConfirmation&&!data.quoteConfirmation.verified &&
       autoOpenedQuote.current!==quote.id){
      autoOpenedQuote.current=quote.id;
      setModalOpen(true);
    }
  },[data?.quotation,data?.quoteConfirmation]);

  // 2. Auto-open modal when quotation OTP challenge is recorded and waiting for code
  useEffect(()=>{
    const quoteChallenge=data?.quoteConfirmation?.challenge;
    if(quoteChallenge?.state==="mock_recorded" &&
       quoteChallenge.challengeId &&
       new Date(quoteChallenge.expiresAt).getTime()>Date.now() &&
       autoOpenedQuoteOtp.current!==quoteChallenge.challengeId){
      autoOpenedQuoteOtp.current=quoteChallenge.challengeId;
      setModalOpen(true);
    }
  },[data?.quoteConfirmation?.challenge]);

  // 3. Auto-open modal when quotation is confirmed and synthetic ID documents are required
  useEffect(()=>{
    const quote=data?.quotation;
    const purchase=data?.purchase;
    const quoteConfirmed=data?.quoteConfirmation?.verified===true;
    if(quote?.id && quoteConfirmed && purchase?.supported && !purchase.confirmed &&
       purchase.missing.length>0 && autoOpenedDocuments.current!==quote.id){
      autoOpenedDocuments.current=quote.id;
      setModalOpen(true);
    }
  },[data?.quotation,data?.quoteConfirmation,data?.purchase]);

  // 4. Auto-open modal when payment OTP challenge is recorded and waiting for code
  useEffect(()=>{
    const quote=data?.quotation;
    const challenge=data?.otp;
    const currentPayment=data?.payment?.payments?.[0]??null;
    const showPaymentOtp=Boolean(
      quote?.state==="verified_completed" &&
      (!currentPayment || currentPayment.state==="payment_declined") &&
      challenge?.state==="mock_recorded" &&
      challenge.challengeId &&
      challenge.quotationId===quote.id &&
      new Date(challenge.expiresAt).getTime()>Date.now(),
    );
    if(showPaymentOtp && challenge?.challengeId && autoOpenedPaymentOtp.current!==challenge.challengeId){
      autoOpenedPaymentOtp.current=challenge.challengeId;
      setModalOpen(true);
    }
  },[data?.quotation,data?.otp,data?.payment?.payments]);

  const activeStage=(()=>{
    const leadState=data?.lead?.state;
    if(leadState && ["queued","running","creating"].includes(leadState))
      return "Sara is preparing your quotation…";
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
      setModalOpen(false);
      await onContinuePurchase();
    }catch(e){
      setError(e instanceof Error?e.message:"Unable to request purchase review");
      setModalOpen(true);
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
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="group flex w-full max-w-xl items-center justify-between gap-3.5 rounded-2xl border border-zinc-200/90 bg-white/90 p-4 text-left shadow-[0_4px_20px_rgba(0,0,0,0.03)] backdrop-blur-xl ring-1 ring-zinc-900/5 transition-all hover:bg-white hover:border-zinc-300 hover:shadow-md active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-zinc-800"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white shadow-xs">
            <SparklesIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <strong className="block text-sm font-semibold text-zinc-900 transition-colors">
              Secure Transaction Hub
            </strong>
            <span className="mt-0.5 block truncate text-xs text-zinc-500">
              {quoteOtpConfirmed
                ? "Quotation confirmed · Synthetic documents & checkout active"
                : "Review verified quote & confirm via private OTP challenge"}
            </span>
          </div>
        </div>
        <span className="shrink-0 rounded-xl bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs group-hover:bg-zinc-800 transition-colors">
          {modalOpen ? "Viewing" : "Open Hub"}
        </span>
      </button>

      {modalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-5"
          role="dialog"
          aria-modal="true"
          aria-labelledby="secure-transaction-title"
        >
          <button
            type="button"
            aria-label="Close secure transaction overlay"
            onClick={() => setModalOpen(false)}
            className="absolute inset-0 bg-zinc-950/60 backdrop-blur-md animate-fade-in"
          />
          <div className="relative z-10 max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-zinc-200/90 bg-white p-5 text-sm shadow-2xl backdrop-blur-2xl ring-1 ring-zinc-900/10 sm:p-7 animate-modal-scale">
            {/* Header */}
            <div className="mb-5 flex items-center justify-between gap-4 border-b border-zinc-200 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex size-8.5 items-center justify-center rounded-xl bg-zinc-900 text-white shadow-xs">
                  <SparklesIcon className="size-4.5" />
                </div>
                <div>
                  <h2 id="secure-transaction-title" className="text-base font-bold text-zinc-900 tracking-tight">
                    Sara · Transaction & Compliance Hub
                  </h2>
                  <p className="text-xs text-zinc-500">Official ANCFZ Regulatory & Payment Pipeline</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close secure transaction"
                className="rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 shadow-2xs transition-all hover:bg-zinc-100 hover:text-zinc-950 active:scale-95"
              >
                Close
              </button>
            </div>

            {/* Quotation summary card */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/80 p-4 shadow-2xs">
              <div>
                <span className="text-[0.68rem] font-semibold tracking-wider uppercase text-zinc-500">
                  Verified Quotation Total
                </span>
                <p className="text-lg font-bold text-zinc-900">
                  {quote.currency} {quote.amount}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-mono font-medium text-zinc-700 shadow-2xs">
                  Ref: {quote.documentNumber}
                </span>
                <span className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-semibold text-zinc-900 shadow-2xs">
                  <CheckIcon className="size-3.5 text-zinc-700" />
                  <span>Verified</span>
                </span>
              </div>
            </div>

            {/* Quotation confirmation / OTP challenge */}
            {!quoteOtpConfirmed && (
              <div className="mt-5 space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50/50 p-4.5 shadow-2xs">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-zinc-900">Confirm this quotation</h3>
                  <span className="rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-[0.68rem] font-semibold text-zinc-700">
                    Step 1 of 3
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-600">
                  Confirm the contact email already provided in our conversation.
                  This sandbox OTP is stored in the private test table; no real email is sent.
                  Identity documents stay locked until the code is verified.
                </p>
                {data?.quoteConfirmation?.contactEmail ? (
                  <div className="rounded-xl border border-zinc-200 bg-white px-3.5 py-2">
                    <span className="text-[0.68rem] font-semibold uppercase text-zinc-400">Authorized Contact</span>
                    <p className="break-all text-sm font-semibold text-zinc-900">
                      {data.quoteConfirmation.contactEmail}
                    </p>
                  </div>
                ) : (
                  <p role="alert" className="text-xs font-medium text-zinc-600">
                    Sara needs to confirm the contact email from your conversation before requesting a code.
                  </p>
                )}
                {quoteOtpChallenge?.state === "mock_recorded" &&
                new Date(quoteOtpChallenge.expiresAt).getTime() > Date.now() ? (
                  <form onSubmit={verifyQuoteOtp} className="space-y-3 pt-1">
                    <label htmlFor="quote-confirmation-code" className="block text-xs font-semibold text-zinc-700">
                      Synthetic quotation confirmation OTP (6 digits)
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        id="quote-confirmation-code"
                        type="password"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        pattern="[0-9]{6}"
                        placeholder="••••••"
                        value={quoteCode}
                        onChange={(event) => setQuoteCode(event.currentTarget.value)}
                        disabled={busy !== null}
                        autoFocus
                        className="w-44 rounded-xl border border-zinc-300 bg-white px-3.5 py-2 text-center text-sm font-mono tracking-widest text-zinc-900 outline-none transition-all focus:border-zinc-900 focus:ring-3 focus:ring-zinc-900/10"
                      />
                      <button
                        type="submit"
                        disabled={busy !== null || !/^[0-9]{6}$/.test(quoteCode)}
                        className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                      >
                        {busy === "quote-otp-verify" ? "Verifying quotation…" : "Verify quotation OTP"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void requestQuoteOtp();
                    }}
                    disabled={busy !== null || !data?.quoteConfirmation?.contactEmail}
                    className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                  >
                    {busy === "quote-otp-request"
                      ? "Recording test code…"
                      : "Confirm this email and request quote OTP"}
                  </button>
                )}
                {quoteOtpChallenge && quoteOtpChallenge.state !== "mock_recorded" && (
                  <p className="text-xs text-zinc-500">
                    The previous code is no longer active. Request another after the cooldown.
                  </p>
                )}
              </div>
            )}

            {/* Quote OTP verified notice */}
            {quoteOtpConfirmed && (
              <p
                role="status"
                className="mt-4 flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs font-semibold text-zinc-900 shadow-2xs"
              >
                <CheckIcon className="size-4 text-zinc-800 shrink-0" />
                <span>Quotation OTP verified. Secure document collection is now unlocked.</span>
              </p>
            )}

            {/* Document Collection Flow */}
            {purchase?.supported && quoteOtpConfirmed && documents.length > 0 && (
              <div className="mt-5 space-y-4">
                {documentsComplete && (
                  <div className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4 shadow-2xs">
                    <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900" role="status">
                      <CheckIcon className="size-4 text-zinc-800 shrink-0" />
                      <span>Required synthetic documents received</span>
                    </p>
                    {documents.some((doc) => doc.status === "synthetic_name_unverified") && (
                      <p className="text-xs font-medium text-zinc-600">
                        POC only: the synthetic passport was classified, but its holder name
                        was not verified. The TEST invoice will use the Emirates ID name.
                        This is not identity verification.
                      </p>
                    )}
                    <p className="text-xs leading-relaxed text-zinc-600">
                      {purchase.reviewIssued
                        ? "Sara's purchase review is available in the chat. Answer the requested billing question or review the exact-amount proposal before authorizing."
                        : "Checkout has not started. Sara is preparing the next purchase-review question; you can also request it using the button below."}{" "}
                      A test OTP, order and invoice require separate authorization and verified payment.
                    </p>
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          void continuePurchase();
                        }}
                        disabled={busy !== null || conversationBusy}
                        className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                      >
                        {busy === "purchase"
                          ? "Requesting purchase review…"
                          : purchase.reviewIssued
                            ? "Ask Sara to show purchase review again"
                            : "Continue to sandbox purchase review"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingDocuments((value) => !value)}
                        disabled={busy !== null || conversationBusy}
                        className="text-xs font-medium text-zinc-600 underline hover:text-zinc-900 disabled:opacity-40"
                      >
                        {editingDocuments ? "Hide document inputs" : "Replace synthetic documents"}
                      </button>
                    </div>
                  </div>
                )}

                {(!documentsComplete||editingDocuments) && (
                  <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4.5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <p className="font-bold text-zinc-900">Upload your synthetic identity documents</p>
                      <span className="rounded-full border border-zinc-300 bg-zinc-50 px-2.5 py-0.5 text-[0.68rem] font-semibold text-zinc-700">
                        Step 2 of 3
                      </span>
                    </div>
                    {uploadStage && (
                      <p
                        role="status"
                        aria-live="polite"
                        className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs font-semibold text-zinc-900 shadow-2xs"
                      >
                        <RefreshCwIcon className="size-4 animate-spin text-zinc-700 shrink-0" />
                        <span>{uploadStage}</span>
                      </p>
                    )}
                    <p className="text-xs text-zinc-500">
                      Development sandbox only. Never upload real identity documents on local HTTP.
                      Files go directly to a private Node endpoint, not to Sara's AI transcript.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      {documents.map((doc) => (
                        <label
                          key={doc.key}
                          className="block cursor-pointer rounded-xl border border-zinc-200 bg-zinc-50/50 p-3.5 shadow-2xs transition-all hover:border-zinc-400 hover:bg-white"
                        >
                          <div className="flex items-center justify-between">
                            <span className="block text-xs font-bold text-zinc-900">{doc.label}</span>
                            <span
                              className={`rounded-md px-1.5 py-0.5 text-[0.65rem] font-bold uppercase ${
                                doc.uploaded
                                  ? "border border-zinc-300 bg-zinc-900 text-white"
                                  : "border border-zinc-200 bg-white text-zinc-600"
                              }`}
                            >
                              {doc.uploaded ? "Uploaded" : doc.required ? "Required" : "Optional"}
                            </span>
                          </div>
                          <span className="mt-1 block text-[0.72rem] text-zinc-500">
                            {doc.uploaded
                              ? "Uploaded — replace anytime before consent"
                              : "PDF, PNG or JPEG, max 1 MiB"}
                          </span>
                          <input
                            className="mt-2 block w-full text-xs text-zinc-500 file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-200 file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-zinc-800 hover:file:bg-zinc-300"
                            type="file"
                            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                            disabled={busy !== null || conversationBusy}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = "";
                              void upload(doc.key, file);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    {purchase.missing.includes("identity_name_mismatch") && (
                      <p role="alert" className="text-xs font-semibold text-rose-700">
                        Extracted identity names do not match. Purchase and invoice are blocked.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Purchase confirmed status */}
            {purchase?.confirmed && !currentPayment && (
              <p className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs font-medium text-zinc-700">
                Sandbox purchase authorized. A synthetic OTP is required before the test order.
              </p>
            )}

            {/* OTP Challenge Form */}
            {showOtp && (
              <form className="mt-4 space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50/50 p-4.5 shadow-2xs" onSubmit={verifyOtp}>
                <label className="block text-xs font-bold text-zinc-900" htmlFor="secure-chat-otp">
                  Enter synthetic payment OTP securely (not in your message)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="secure-chat-otp"
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    pattern="[0-9]{6}"
                    placeholder="••••••"
                    value={otp}
                    onChange={(event) => setOtp(event.currentTarget.value)}
                    autoFocus
                    className="w-44 rounded-xl border border-zinc-300 bg-white px-3.5 py-2 text-center text-sm font-mono tracking-widest text-zinc-900 outline-none transition-all focus:border-zinc-900 focus:ring-3 focus:ring-zinc-900/10"
                  />
                  <button
                    type="submit"
                    disabled={busy !== null || !/^\d{6}$/.test(otp)}
                    className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                  >
                    {busy === "otp" ? "Verifying…" : "Verify test OTP"}
                  </button>
                </div>
              </form>
            )}

            {/* Expired OTP retry */}
            {challenge && !showOtp && !currentPayment && purchase?.confirmed && (
              <div className="mt-4 space-y-2 rounded-2xl border border-zinc-200 bg-zinc-50/50 p-4 shadow-2xs">
                <p className="text-xs font-medium text-zinc-700">
                  This test OTP is no longer usable. Request a fresh code; the original cannot be reused.
                </p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={()=>{void renewPaymentOtp();}}
                  className="rounded-xl border border-zinc-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-zinc-800 shadow-2xs transition-all hover:bg-zinc-50 disabled:opacity-40"
                >
                  {busy === "renew-otp" ? "Requesting…" : "Request new OTP"}
                </button>
              </div>
            )}

            {/* Current Payment Section */}
            {currentPayment && (
              <div className="mt-5 space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50/60 p-4.5 shadow-2xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-zinc-900">Sandbox Order</span>
                  <span className="rounded-lg border border-zinc-200 bg-white px-2.5 py-0.5 text-xs font-bold uppercase text-zinc-800">
                    {currentPayment.state.replaceAll("_", " ")}
                  </span>
                </div>

                {currentPayment.state === "payment_declined" && !showOtp && (
                  <div className="space-y-2.5 pt-1">
                    <p className="text-xs font-medium text-zinc-700">
                      The provider confirmed DECLINED. Your quotation and identity documents are retained.
                      A new sandbox link requires a fresh OTP; your old order will not be retried.
                    </p>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={()=>{void renewPaymentOtp();}}
                      className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                    >
                      {busy === "renew-otp" ? "Requesting…" : "Retry declined payment — request new OTP"}
                    </button>
                  </div>
                )}

                {currentPayment.orderReference &&
                  currentPayment.providerPaymentId &&
                  ["checkout_available", "order_created_checkout_unavailable", "payment_pending"].includes(
                    currentPayment.state,
                  ) && (
                    <div className="space-y-2.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          void reopenCheckout();
                        }}
                        disabled={busy !== null || checkoutWatcher.current !== null}
                        className="inline-block rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                      >
                        {busy === "checkout"
                          ? "Opening secure checkout…"
                          : checkoutWatcher.current
                            ? "Checkout window open"
                            : "Click to pay"}
                      </button>
                      {safeCheckoutUrl(fallbackCheckoutUrl) && (
                        <a
                          href={fallbackCheckoutUrl}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="block text-xs font-medium text-zinc-700 underline hover:text-zinc-950"
                        >
                          Open existing checkout in a new tab (popup fallback)
                        </a>
                      )}
                    </div>
                  )}

                {currentPayment.state === "unknown_outcome" && (
                  <div className="space-y-2.5 pt-1">
                    <p role="alert" className="text-xs font-medium text-zinc-800">
                      Provider outcome unknown. Do not create another payment order.
                    </p>
                    {currentPayment.providerStatus && (
                      <p className="text-xs text-zinc-600">
                        Dispatch diagnostic: {currentPayment.providerStatus}
                      </p>
                    )}
                    {!currentPayment.orderReference && (
                      <form className="space-y-2.5" onSubmit={reconcileOrder}>
                        <label className="block text-xs font-semibold text-zinc-700" htmlFor="existing-gateway-order">
                          Existing MockGateway RefNo / OrderNo (operator recovery)
                        </label>
                        <input
                          id="existing-gateway-order"
                          autoComplete="off"
                          value={orderReference}
                          onChange={(event) => setOrderReference(event.currentTarget.value)}
                          maxLength={120}
                          placeholder="Existing provider order number"
                          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
                        />
                        <label className="block text-xs font-semibold text-zinc-700" htmlFor="existing-gateway-payment-id">
                          MockGateway transaction ID (for record matching, not GET lookup)
                        </label>
                        <input
                          id="existing-gateway-payment-id"
                          autoComplete="off"
                          value={providerPaymentId}
                          onChange={(event) => setProviderPaymentId(event.currentTarget.value)}
                          maxLength={120}
                          placeholder="Transaction ID from MockGateway dashboard"
                          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-xs text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10"
                        />
                        <p className="text-[0.72rem] text-zinc-500">
                          Read-only gateway lookup uses the existing RefNo/OrderNo. Enter its matching
                          dashboard transaction ID for recovery tracking. No new order or OTP will be generated.
                        </p>
                        <button
                          type="submit"
                          disabled={
                            busy !== null ||
                            !/^[A-Za-z0-9_-]{1,120}$/.test(orderReference.trim()) ||
                            !/^[A-Za-z0-9_-]{1,120}$/.test(providerPaymentId.trim())
                          }
                          className="rounded-xl bg-zinc-900 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
                        >
                          {busy === "reconcile" ? "Checking existing order…" : "Reconcile existing order (GET only)"}
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Unified Generated Documents Section */}
            <div className="mt-6 border-t border-zinc-200/90 pt-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold tracking-wider uppercase text-zinc-900">
                    Official Generated Documents
                  </h3>
                  <p className="text-[0.72rem] text-zinc-500">
                    Verified PDF documents issued by the regulatory & payment pipeline
                  </p>
                </div>
                <span className="rounded-full bg-zinc-100 px-2.5 py-0.5 text-[0.68rem] font-semibold text-zinc-700 border border-zinc-200">
                  PDF
                </span>
              </div>

              <div className="space-y-2.5">
                {/* 1. Official Quotation */}
                {quote.pdfAvailable && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3.5 transition-all hover:border-zinc-300 hover:bg-zinc-50">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white border border-zinc-200 text-zinc-900 shadow-2xs">
                        <FileTextIcon className="size-5 text-zinc-800" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold text-zinc-900">Official Quotation</p>
                          <span className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[0.65rem] font-mono font-semibold text-zinc-700">
                            {quote.documentNumber}
                          </span>
                        </div>
                        <p className="text-[0.72rem] text-zinc-500 truncate">
                          {quote.currency} {quote.amount} · Verified Service Proposal
                        </p>
                      </div>
                    </div>
                    <a
                      href={root + "/quotations/" + encodeURIComponent(quote.id) + "/pdf"}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-zinc-800 active:scale-95 transition-all shrink-0"
                    >
                      <DownloadIcon className="size-3.5 text-zinc-300" />
                      <span>Download PDF</span>
                    </a>
                  </div>
                )}

                {/* 2. Service Agreement */}
                {contract && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3.5 transition-all hover:border-zinc-300 hover:bg-zinc-50">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white border border-zinc-200 text-zinc-900 shadow-2xs">
                        <ShieldCheckIcon className="size-5 text-zinc-800" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold text-zinc-900">Service Agreement</p>
                          <span className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[0.65rem] font-mono font-semibold text-zinc-700">
                            {contract.documentNumber}
                          </span>
                        </div>
                        <p className="text-[0.72rem] text-zinc-500 truncate">
                          {contract.pdfAvailable
                            ? "Private TEST Service Agreement (Non-binding Demo)"
                            : ["queued", "running"].includes(contract.state)
                              ? "Preparing agreement following independent checks…"
                              : contract.state === "needs_review"
                                ? "Review pending — no identity number fabricated"
                                : "Awaiting issuance"}
                        </p>
                      </div>
                    </div>
                    {contract.pdfAvailable ? (
                      <a
                        href={root + "/contracts/" + encodeURIComponent(contract.id) + "/pdf"}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-zinc-800 active:scale-95 transition-all shrink-0"
                      >
                        <DownloadIcon className="size-3.5 text-zinc-300" />
                        <span>Download PDF</span>
                      </a>
                    ) : ["queued", "running"].includes(contract.state) ? (
                      <span className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-500 shadow-2xs shrink-0">
                        <RefreshCwIcon className="size-3.5 animate-spin text-zinc-400" />
                        <span>Preparing…</span>
                      </span>
                    ) : contract.state === "needs_review" ? (
                      <span className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 shadow-2xs shrink-0">
                        <AlertCircleIcon className="size-3.5 text-zinc-500" />
                        <span>Needs Review</span>
                      </span>
                    ) : null}
                  </div>
                )}

                {/* 3. Tax Invoice */}
                {invoice && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50/70 p-3.5 transition-all hover:border-zinc-300 hover:bg-zinc-50">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white border border-zinc-200 text-zinc-900 shadow-2xs">
                        <FileTextIcon className="size-5 text-zinc-800" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-bold text-zinc-900">Tax Invoice</p>
                          <span className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[0.65rem] font-mono font-semibold text-zinc-700">
                            {invoice.documentNumber}
                          </span>
                        </div>
                        <p className="text-[0.72rem] text-zinc-500 truncate">
                          {invoice.pdfAvailable
                            ? "Verified Commercial Tax Invoice (Paid)"
                            : "Invoice generation in progress…"}
                        </p>
                      </div>
                    </div>
                    {invoice.pdfAvailable ? (
                      <a
                        href={root + "/invoices/" + encodeURIComponent(invoice.id) + "/pdf"}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-zinc-800 active:scale-95 transition-all shrink-0"
                      >
                        <DownloadIcon className="size-3.5 text-zinc-300" />
                        <span>Download PDF</span>
                      </a>
                    ) : (
                      <span className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-500 shadow-2xs shrink-0">
                        <RefreshCwIcon className="size-3.5 animate-spin text-zinc-400" />
                        <span>Processing…</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Error & Notice Callouts */}
            {error && (
              <div role="alert" className="mt-4 flex items-center gap-2 rounded-xl border border-rose-200/80 bg-rose-50/80 p-3 text-xs text-rose-800 shadow-2xs">
                <AlertCircleIcon className="size-4 text-rose-600 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {notice && (
              <div role="status" className="mt-4 flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-zinc-50/80 p-3 text-xs text-zinc-700 shadow-2xs">
                <CheckIcon className="size-4 text-zinc-800 shrink-0" />
                <span>{notice}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
