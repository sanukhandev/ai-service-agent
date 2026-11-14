"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

export const PURCHASE_CONSENT =
  "I confirm that I want to proceed with this ANCFZ sandbox purchase for the exact approved quotation amount and that the required test documents have been submitted.";
type Quote={id:string;amount:string;currency:string};
type Requirement={
  key:string;label:string;guidance:string|null;required:boolean;uploaded:boolean;
  fileName:string|null;documentId:string|null;status:string;
};
type Purchase={
  supported:boolean;intentKey:string|null;quotationId:string|null;amount:string|null;
  currency:string|null;requirements:Requirement[];confirmed:boolean;readyForOtp:boolean;
  missing:string[];billingName:string|null;persona:{name:string;tone:string};
};
async function json(path:string,method:"GET"|"POST"="GET",body?:object){
  const res=await fetch(path,{
    method,credentials:"include",cache:"no-store",
    headers:{Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  });
  const data=await res.json();
  if(!res.ok)throw Error(data?.message??"Unable to process purchase request");
  return data;
}
async function asBase64(file:File):Promise<string>{
  if(file.size<100 || file.size>1048576)
    throw Error("Choose a document between 100 bytes and 1 MiB");
  const result=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(String(reader.result));
    reader.onerror=()=>reject(Error("Unable to read selected file"));
    reader.readAsDataURL(file);
  });
  const encoded=result.split(",")[1];
  if(!encoded)throw Error("Could not encode the selected file");
  return encoded;
}
export function PurchaseChecklist({
  ticketId,quote,onReady,revision,
}:{
  ticketId:string;quote:Quote|null;onReady:(ready:boolean)=>void;revision:number;
}){
  const [data,setData]=useState<Purchase|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [consent,setConsent]=useState(false);
  const [notice,setNotice]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const reqId=useRef<string|null>(null);
  const url="/api/v1/tickets/"+encodeURIComponent(ticketId)+"/purchase";
  const load=useCallback(async()=>{
    const result=await json(url) as Purchase;
    setData(result);
    onReady(result.readyForOtp===true && result.quotationId===quote?.id);
  },[url,quote?.id,onReady]);
  useEffect(()=>{
    let active=true;
    async function refresh(){
      try{
        const result=await json(url) as Purchase;
        if(active){
          setData(result);
          onReady(result.readyForOtp===true && result.quotationId===quote?.id);
        }
      }catch{if(active)onReady(false);}
    }
    void refresh();
    return ()=>{active=false;onReady(false);};
  },[url,quote?.id,onReady,revision]);

  async function upload(key:string,file:File|undefined){
    if(!file || busy)return;
    setBusy(key);setError(null);setNotice(null);
    try{
      if(!["application/pdf","image/png","image/jpeg"].includes(file.type))
        throw Error("Use a PDF, PNG or JPEG file");
      const dataBase64=await asBase64(file);
      await json(url+"/documents","POST",{
        requirementKey:key,fileName:file.name,contentType:file.type,dataBase64,
      });
      setNotice("Test document received in your private ticket. Document authenticity is not verified.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Document upload failed");}
    finally{setBusy(null);}
  }
  async function confirm(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    if(!data || !quote || data.confirmed || data.missing.length || busy || !consent)return;
    setBusy("confirm");setError(null);setNotice(null);
    const requestId=reqId.current??crypto.randomUUID();
    reqId.current=requestId;
    try{
      await json(url+"/confirm","POST",{
        requestId,quotationId:quote.id,amount:quote.amount,currency:quote.currency,
        consent:true,consentText:PURCHASE_CONSENT,
      });
      reqId.current=null;
      setNotice("Purchase confirmed for this quotation. Complete the separate test-payment OTP step next.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Purchase confirmation failed");}
    finally{setBusy(null);}
  }
  if(!data)return <p className="mt-2 text-xs text-slate-500">Loading purchase checklist…</p>;
  if(!data.supported)return <p className="mt-2 text-xs text-amber-800">
    This ticket is not using the purchase-enabled intent catalog. Start a new ticket to upload the two identity documents.
  </p>;
  if(data.confirmed)return <p role="status" className="mt-2 text-xs text-emerald-800">
    Purchase confirmed and documents recorded for this quotation. Proceed with test OTP verification.
  </p>;
  return <section aria-label="Purchase documents and confirmation" className="mt-3 space-y-3 rounded-lg border border-slate-200 p-3">
    <h3 className="font-semibold text-slate-900">Passport and Emirates ID</h3>
    <p className="text-xs text-slate-700">Upload passport and Emirates ID for
      <strong> {data.intentKey?.replaceAll("_"," ")}</strong>.
      {quote?<span> Then confirm the approved quotation amount:
        <strong> {quote.currency} {quote.amount}</strong>.</span>:
        <span> Purchase confirmation becomes available after the quotation is approved.</span>}</p>
    <p className="text-xs text-amber-800">Development-only sandbox checklist.
      Use synthetic documents only; these are not verified regulatory requirements.
      Local HTTP is not suitable for real passport or identity files.</p>
    {data.requirements.map(item=><div key={item.key} className="rounded border border-slate-200 p-2 text-xs">
      <p className="font-medium">{item.label}{item.required?" (required)":""}</p>
      {item.guidance&&<p className="mt-1 text-slate-600">{item.guidance}</p>}
      {item.uploaded?<p className="mt-1 text-emerald-800">
        Received: {item.fileName}
        {item.documentId&&<a className="ml-2 underline"
          href={url+"/documents/"+encodeURIComponent(item.documentId)}>Download</a>}
      </p>:<label className="mt-2 block">
        Upload PDF, PNG or JPEG (max 1 MiB)
        <input className="mt-1 block w-full text-xs" type="file"
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          disabled={busy!==null}
          onChange={e=>{void upload(item.key,e.target.files?.[0]);e.target.value="";}}/>
      </label>}
    </div>)}
    {data.billingName&&<p className="text-xs font-medium text-slate-700">Document-derived billing name: {data.billingName}</p>}
    {data.missing.includes("identity_name_mismatch")&&<p role="alert" className="text-xs text-rose-700">The passport and Emirates ID holder names disagree. Invoice creation is blocked until resolved.</p>}
    {error&&<p role="alert" className="text-xs text-rose-700">{error}</p>}
    {notice&&<p role="status" className="text-xs text-indigo-800">{notice}</p>}
    {quote&&data.quotationId===quote.id&&<form className="space-y-2" onSubmit={confirm}>
      <label className="flex gap-2 text-xs"><input type="checkbox" required
        checked={consent} onChange={e=>setConsent(e.target.checked)}/>
        <span>{PURCHASE_CONSENT}</span></label>
      <button type="submit"
        disabled={!consent||data.requirements.length===0||data.missing.length>0||busy!==null}
        className="rounded bg-indigo-700 px-3 py-2 font-semibold text-white disabled:opacity-50">
        {busy==="confirm"?"Confirming…":"Confirm purchase and proceed to OTP"}
      </button>
    </form>}
  </section>;
}
