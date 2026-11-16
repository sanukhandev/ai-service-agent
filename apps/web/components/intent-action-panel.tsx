"use client";

import { useEffect, useRef, useState } from "react";
import { LeadSubmission } from "./lead-submission";
import { QuotationRequest } from "./quotation-request";
import { PaymentCheckout } from "./payment-checkout";
import { uniqueActionsByKey } from "../lib/unique-actions";

const consentText =
  "I ask ANCFZ to record this POC service request using the information I provided in this ticket. I understand this does not submit an application to a bank, government body or external partner.";

type Action={
  actionKey:string;label:string;
  kind:"ticket_request"|"salesforce_lead"|"quotation"|"purchase";
  requirements:{key:string;label:string;present:boolean}[];
  missing:string[];ready:boolean;
  request:{id:string;status:string}|null;
};
type Catalog={
  intentKey:string|null;intentName?:string;
  actions:Action[];unknownActions:string[];
};
export function IntentActionPanel({ticketId,revision}:{ticketId:string;revision:number}){
  const [catalog,setCatalog]=useState<Catalog|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [accepted,setAccepted]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const requestIds=useRef<Record<string,string>>({});
  useEffect(()=>{
    let active=true;
    async function refresh(){
      try{
        const r=await fetch("/api/v1/tickets/"+encodeURIComponent(ticketId)+"/intent-actions",{
          cache:"no-store",credentials:"include",
        });
        if(!r.ok)throw Error("Action catalog unavailable");
        const response=await r.json() as Catalog;
        if(active)setCatalog(response);
      }catch{if(active)setCatalog(null);}
    }
    void refresh();
    return ()=>{active=false;};
  },[ticketId,revision]);
  useEffect(()=>{
    setSelected(null);setAccepted(false);setNotice(null);setError(null);
    requestIds.current={};
  },[catalog?.intentKey]);
  async function submit(action:Action){
    if(sending||!accepted||!action.ready||action.kind!=="ticket_request")return;
    setSending(true);setError(null);setNotice(null);
    const requestId=requestIds.current[action.actionKey]??crypto.randomUUID();
    requestIds.current[action.actionKey]=requestId;
    try{
      const response=await fetch("/api/v1/tickets/"+
        encodeURIComponent(ticketId)+"/intent-actions/"+encodeURIComponent(action.actionKey),{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json",Accept:"application/json"},
        body:JSON.stringify({requestId,consent:true,consentText}),
      });
      const payload=await response.json();
      if(!response.ok)throw Error(typeof payload.message==="string"?payload.message:"Request not recorded");
      setCatalog(previous=>previous?{...previous,actions:previous.actions.map(item=>
        item.actionKey===action.actionKey?{...item,request:payload.request}:item)}:previous);
      setNotice("Recorded in this ticket for staff review. No external application has been submitted.");
      setSelected(null);setAccepted(false);
      delete requestIds.current[action.actionKey];
    }catch(e){setError(e instanceof Error?e.message:"Unable to record service request");}
    finally{setSending(false);}
  }
  if(!catalog?.intentKey)return null;
  // Server catalog entries can be repeated; one actionable control per key.
  const actions=uniqueActionsByKey(catalog.actions);
  return <section className="mb-3 space-y-2" aria-label="Available intent actions">
    <p className="text-xs font-semibold text-slate-700">
      Available actions for {catalog.intentName??catalog.intentKey.replaceAll("_"," ")}
    </p>
    {actions.map(action=>{
      if(action.kind==="salesforce_lead"||action.kind==="quotation"){
        // Sara asks missing fields one at a time in chat. Show the approval
        // control only when the authoritative Node catalog reports readiness.
        if(!action.ready)return null;
        return <div key={catalog.intentKey+":"+action.actionKey} className="space-y-2">
          {action.kind==="salesforce_lead"
            ?<LeadSubmission ticketId={ticketId} revision={revision}/>
            :<QuotationRequest ticketId={ticketId} revision={revision}/>}
        </div>;
      }
      if(action.kind==="purchase")return <PaymentCheckout key={catalog.intentKey+":"+action.actionKey} ticketId={ticketId} revision={revision}/>;
      return <div key={action.actionKey} className="rounded-lg border border-slate-200 p-3 text-xs">
        <p className="font-semibold">{action.label}</p>
        {action.request?<p className="mt-1 text-blue-800">
          Recorded: {action.request.status.replaceAll("_"," ")} — no external submission
        </p>:<>
          {action.missing.length>0&&<p className="mt-1 text-slate-600">
            Tell Sara these missing details before requesting:
            {" "+action.requirements.filter(r=>!r.present).map(r=>r.label).join(", ")}
          </p>}
          <button type="button" className="mt-2 rounded border border-blue-200 px-3 py-1.5
            font-semibold text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!action.ready||sending}
            onClick={()=>{setSelected(action.actionKey);setAccepted(false);setError(null);}}>
            Record {action.label.toLowerCase()}
          </button>
          {selected===action.actionKey&&<div className="mt-2 space-y-2">
            <label className="flex gap-2"><input type="checkbox"
              checked={accepted} onChange={e=>setAccepted(e.target.checked)} />
              <span>{consentText}</span></label>
            <button type="button" disabled={!accepted||sending}
              onClick={()=>{void submit(action);}}
              className="rounded bg-blue-700 px-3 py-2 font-semibold text-white disabled:opacity-50">
              {sending?"Recording…":"Confirm and record in ticket"}
            </button>
            <button type="button" onClick={()=>{setSelected(null);setAccepted(false);}}
              className="ml-2 underline">Cancel</button>
          </div>}
        </>}
      </div>;
    })}
    {catalog.unknownActions?.length>0&&<p role="alert" className="text-xs text-amber-800">
      Unsupported catalog actions: {catalog.unknownActions.join(", ")}.
      No external operations were attempted.
    </p>}
    {notice&&<p role="status" className="text-xs text-blue-800">{notice}</p>}
    {error&&<p role="alert" className="text-xs text-red-700">{error}</p>}
  </section>;
}
