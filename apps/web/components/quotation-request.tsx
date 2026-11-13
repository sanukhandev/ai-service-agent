"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const acknowledgmentText =
  "I request a non-binding ANCFZ test quotation for the selected published package price, subject to ANCFZ confirmation.";

interface PriceOption {
  offeringKey:string;label:string;currency:string;amount:string;
  priceRevision:number;conditions:string|null;
}
interface Quotation {
  id:string;state:string;documentNumber:string;
  offeringKey:string;offeringLabel:string;amount:string;currency:string;
  conditions:string|null;pdfAvailable:boolean;
}

export function QuotationRequest({ticketId}:{ticketId:string}) {
  const [enabled,setEnabled]=useState(false);
  const [leadVerified,setLeadVerified]=useState(false);
  const [options,setOptions]=useState<PriceOption[]>([]);
  const [quotation,setQuotation]=useState<Quotation|null>(null);
  const [customerName,setCustomerName]=useState("");
  const [offeringKey,setOfferingKey]=useState("");
  const [acknowledged,setAcknowledged]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const requestId=useRef<string|null>(null);

  useEffect(()=>{
    let cancelled=false;
    async function refresh(){
      try{
        const [available,stored]=await Promise.all([
          fetch(`/api/v1/tickets/${encodeURIComponent(ticketId)}/quotation-options`,{
            credentials:"same-origin",cache:"no-store",
          }),
          fetch(`/api/v1/tickets/${encodeURIComponent(ticketId)}/quotations`,{
            credentials:"same-origin",cache:"no-store",
          }),
        ]);
        if(!available.ok||!stored.ok)return;
        const [a,q]=await Promise.all([available.json(),stored.json()]);
        if(cancelled)return;
        setEnabled(a.enabled===true);
        setLeadVerified(a.leadVerified===true);
        const list:PriceOption[]=Array.isArray(a.options)?a.options:[];
        setOptions(list);
        setOfferingKey(key=>key||list[0]?.offeringKey||"");
        setQuotation(q.quotation??null);
      }catch{/* Network state is shown by the parent chat. */}
    }
    void refresh();
    const id=setInterval(()=>{void refresh();},6000);
    return ()=>{cancelled=true;clearInterval(id);};
  },[ticketId]);

  const chosen=options.find(option=>option.offeringKey===offeringKey);
  if(!enabled&&!quotation)return null;
  if(quotation)return <section className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900"
    aria-label="Quotation status">
    <p><strong>ANCFZ test quotation {quotation.documentNumber}</strong> · {quotation.state.replaceAll("_"," ")}</p>
    <p>{quotation.offeringLabel} — {quotation.currency} {Number(quotation.amount).toLocaleString("en-AE",{minimumFractionDigits:2})}</p>
    {quotation.pdfAvailable&&
      <a className="mt-2 inline-flex font-semibold text-blue-700 underline"
        href={`/api/v1/tickets/${encodeURIComponent(ticketId)}/quotations/${encodeURIComponent(quotation.id)}/pdf`}>
        Download quotation PDF
      </a>}
    {quotation.state==="unknown_outcome"&&
      <p className="mt-1">PDF rendering needs manual reconciliation. Do not request another quotation.</p>}
  </section>;

  if(!leadVerified||options.length===0)return null;

  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    if(submitting||!acknowledged||!chosen)return;
    setSubmitting(true);
    setError(null);
    const id=requestId.current??crypto.randomUUID();
    requestId.current=id;
    try{
      const response=await fetch(`/api/v1/tickets/${encodeURIComponent(ticketId)}/quotations`,{
        method:"POST",credentials:"same-origin",
        headers:{"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({
          requestId:id,offeringKey:chosen.offeringKey,
          customerName,acknowledged:true,acknowledgmentText,
        }),
      });
      const body=await response.json();
      if(!response.ok)throw new Error(
        typeof body.message==="string"?body.message:"Could not queue quotation",
      );
      if(!body.quotation?.id)throw new Error("Invalid quotation response");
      setQuotation(body.quotation);
      setExpanded(false);
    }catch(e){
      setError(e instanceof Error?e.message:"Could not queue quotation");
    }finally{setSubmitting(false);}
  }

  return <section className="mb-3">
    <button type="button" onClick={()=>setExpanded(value=>!value)}
      className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-50">
      {expanded?"Close quotation request":"Request a non-binding test quotation"}
    </button>
    {expanded&&<form onSubmit={submit} className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h2 className="font-semibold">ANCFZ quotation</h2>
      <p className="text-xs text-amber-800">Test prices only. This is not a binding commercial offer or invoice.
        Health insurance and office upgrades may be excluded.</p>
      <label className="flex flex-col gap-1 text-xs font-medium">Name on quotation
        <input required maxLength={200} value={customerName}
          onChange={e=>setCustomerName(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">Published package and term
        <select required value={offeringKey}
          onChange={e=>setOfferingKey(e.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          {options.map(option=><option key={option.offeringKey} value={option.offeringKey}>
            {option.label} · {option.currency} {Number(option.amount).toLocaleString("en-AE",{minimumFractionDigits:2})}
          </option>)}
        </select>
      </label>
      {chosen?.conditions&&<p className="text-xs text-slate-600">{chosen.conditions}</p>}
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" required checked={acknowledged}
          onChange={e=>setAcknowledged(e.target.checked)} className="mt-0.5"/>
        <span>{acknowledgmentText}</span>
      </label>
      {error&&<p role="alert" className="text-xs text-rose-700">{error}</p>}
      <button disabled={submitting||!acknowledged||!chosen}
        type="submit" className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {submitting?"Requesting…":"Request quotation"}
      </button>
    </form>}
  </section>;
}
