"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const consentText = "I authorize ANCFZ to send my contact details to Salesforce to process this enquiry.";

interface Operation {
  id:string;
  operation:"ancfz_salesforce_lead";
  state:string;
  providerReference:string|null;
}
type Fields = {name:string;company:string;phone:string;email:string;description:string};
const blank:Fields={name:"",company:"",phone:"",email:"",description:""};

export function LeadSubmission({ticketId}:{ticketId:string}) {
  const [enabled,setEnabled]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const [fields,setFields]=useState<Fields>(blank);
  const [consent,setConsent]=useState(false);
  const [sending,setSending]=useState(false);
  const [operation,setOperation]=useState<Operation|null>(null);
  const [error,setError]=useState<string|null>(null);
  const requestId=useRef<string|null>(null);

  useEffect(()=>{
    let active=true;
    setEnabled(false);
    setOperation(null);
    setExpanded(false);
    fetch(`/api/v1/tickets/${encodeURIComponent(ticketId)}/operations`,{
      credentials:"include",cache:"no-store",
    }).then(async response=>{
      if(!response.ok) throw new Error("Operation status unavailable");
      return await response.json();
    }).then(data=>{
      if(!active)return;
      setEnabled(data.enabled===true);
      setOperation(Array.isArray(data.operations)?data.operations.find(
        (op:Operation)=>op.operation==="ancfz_salesforce_lead",
      )??null:null);
    }).catch(()=>{if(active)setEnabled(false);});
    return ()=>{active=false;};
  },[ticketId]);

  if(!enabled)return null;

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!consent||sending||operation)return;
    setSending(true);
    setError(null);
    const id=requestId.current??crypto.randomUUID();
    requestId.current=id;
    try {
      const response=await fetch(`/api/v1/tickets/${encodeURIComponent(ticketId)}/operations/salesforce-lead`,{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({...fields,consent:true,consentText,requestId:id}),
      });
      const body=await response.json();
      if(!response.ok)throw new Error(typeof body.message==="string"?body.message:"Lead submission unavailable");
      if(!body.operation || typeof body.operation.id!=="string")throw new Error("Unexpected response");
      setOperation(body.operation);
      setExpanded(false);
    }catch(e){
      setError(e instanceof Error?e.message:"Lead submission unavailable");
    }finally{setSending(false);}
  }

  if(operation)return <p role="status" className="mb-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
    Salesforce enquiry: <strong>{operation.state.replaceAll("_"," ")}</strong>
    {operation.providerReference?" · Lead "+operation.providerReference:""}
    {operation.state==="unknown_outcome"?" — Requires manual reconciliation; do not submit again.":""}
  </p>;

  return <div className="mb-3 text-sm">
    <button type="button" onClick={()=>setExpanded(v=>!v)}
      className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-50">
      {expanded?"Close lead request":"Request Salesforce follow-up"}
    </button>
    {expanded&&<form onSubmit={submit} className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="font-semibold">Request an ANCFZ follow-up</h2>
      <p className="text-xs text-slate-600">Your contact details will be submitted to the ANCFZ Salesforce sandbox only after you agree below. Sending a message to Sara does not submit a lead.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(["name","company","phone","email"] as const).map(key=><label key={key} className="flex flex-col gap-1 text-xs font-medium capitalize">
          {key}
          <input required type={key==="email"?"email":key==="phone"?"tel":"text"}
            maxLength={key==="company"?255:key==="email"?254:key==="phone"?40:120}
            value={fields[key]} onChange={e=>setFields(v=>({...v,[key]:e.target.value}))}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>)}
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">Enquiry summary
        <textarea required maxLength={4000} rows={2} value={fields.description}
          onChange={e=>setFields(v=>({...v,description:e.target.value}))}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)}
          className="mt-0.5" />
        <span>{consentText}</span>
      </label>
      {error&&<p role="alert" className="text-xs text-red-700">{error}</p>}
      <button type="submit" disabled={!consent||sending}
        className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {sending?"Submitting…":"Authorize and send lead"}
      </button>
    </form>}
  </div>;
}
