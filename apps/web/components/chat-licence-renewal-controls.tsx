"use client";

import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";

/** POC-only, owner-scoped licence lookup. Neither a licence number nor a click
 * here can create a quote, authorize a renewal, issue an OTP or charge funds.
 */
type RenewalView={
  licenceNumber:string;companyName:string;status:string;expiresOn:string;
  offeringKey:string;termYears:number;fingerprint:string;
  confirmed:boolean;confirmationText:string;
};
type State={enabled:boolean;applicable:boolean;record:RenewalView|null};
async function json<T>(path:string,body?:object):Promise<T>{
  const res=await fetch(path,{
    method:body?"POST":"GET",cache:"no-store",credentials:"include",
    headers:{Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),
  });
  let value:unknown;
  try{value=await res.json();}catch{throw Error("Invalid renewal service response");}
  if(!res.ok){
    const o=value as {message?:unknown};
    throw Error(typeof o?.message==="string"?o.message:"Licence renewal request was rejected");
  }
  return value as T;
}
export function ChatLicenceRenewalControls({
  ticketId,revision,conversationBusy,onConfirmed,
}:{
  ticketId:string;revision:number;conversationBusy:boolean;
  onConfirmed:()=>Promise<void>;
}){
  const root="/api/v1/tickets/"+encodeURIComponent(ticketId);
  const [state,setState]=useState<State|null>(null);
  const [licenceNumber,setLicenceNumber]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const requestId=useRef<string|null>(null);
  const load=useCallback(async()=>{
    const fresh=await json<State>(root+"/renewal");
    setState(fresh);
    return fresh;
  },[root]);
  useEffect(()=>{
    let active=true;
    void json<State>(root+"/renewal").then(x=>{
      if(active)setState(x);
    }).catch(()=>{if(active)setState(null);});
    return ()=>{active=false};
  },[root,revision]);
  const lookup=async(e:FormEvent<HTMLFormElement>)=>{
    e.preventDefault();if(busy||conversationBusy)return;
    setBusy(true);setError(null);requestId.current=null;
    try{
      await json<RenewalView>(root+"/renewal/lookup",{
        licenceNumber:licenceNumber.trim().toUpperCase(),
      });
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Licence lookup failed");}
    finally{setBusy(false);}
  };
  const confirm=async()=>{
    const found=state?.record;
    if(!found||busy||conversationBusy)return;
    setBusy(true);setError(null);
    try{
      requestId.current??=crypto.randomUUID();
      await json<RenewalView>(root+"/renewal/confirm",{
        requestId:requestId.current,fingerprint:found.fingerprint,
        consentText:found.confirmationText,
      });
      await load();
      await onConfirmed();
    }catch(e){setError(e instanceof Error?e.message:"Unable to confirm renewal details");}
    finally{setBusy(false);}
  };
  if(!state?.applicable)return null;
  return (
    <section className="mt-4 space-y-3 rounded-xl border border-zinc-200 bg-white p-4"
      aria-label="ANCFZ synthetic licence renewal">
      <h3 className="text-sm font-semibold">Existing licence renewal</h3>
      <p className="text-xs text-zinc-600">
        Development-only test records from the private n8n licence table.
        A matched licence number is not proof of ownership or official renewal eligibility.
      </p>
      {!state.enabled?(
        <p role="status" className="text-xs text-amber-800">
          Synthetic renewal lookup is disabled. Ask ANCFZ staff to configure the service.
        </p>
      ):state.record?.confirmed?(
        <div className="space-y-2 text-sm">
          <p className="font-medium text-emerald-800" role="status">
            Synthetic licence details confirmed for quotation review
          </p>
          <p>Licence: {state.record.licenceNumber}</p>
          <p>Company: {state.record.companyName}</p>
          <p>Current expiry: {state.record.expiresOn}</p>
          <p>Requested renewal: {state.record.termYears} year(s)</p>
          <p className="text-xs text-zinc-600">
            Sara can prepare a non-binding renewal quotation only when a
            published price exists. A sandbox order and invoice require
            separate purchase authorization, OTP and verified test payment.
          </p>
        </div>
      ):state.record?(
        <div className="space-y-2 text-sm">
          <p className="font-medium">Confirm the matched synthetic licence details</p>
          <dl className="grid grid-cols-2 gap-1 text-xs">
            <dt>Licence</dt><dd>{state.record.licenceNumber}</dd>
            <dt>Company</dt><dd>{state.record.companyName}</dd>
            <dt>Status</dt><dd>{state.record.status}</dd>
            <dt>Current expiry</dt><dd>{state.record.expiresOn}</dd>
            <dt>Renewal duration</dt><dd>{state.record.termYears} year(s)</dd>
            <dt>Quoted package</dt><dd>{state.record.offeringKey} (price pending published catalog)</dd>
          </dl>
          <p className="text-xs text-zinc-700">{state.record.confirmationText}</p>
          <button type="button" onClick={()=>{void confirm();}}
            disabled={busy||conversationBusy}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
            {busy?"Confirming…":"Confirm these licence details"}
          </button>
          <button type="button" onClick={()=>setState({...state,record:null})}
            disabled={busy||conversationBusy}
            className="ml-3 text-xs underline">
            Look up another synthetic licence
          </button>
        </div>
      ):(
        <form onSubmit={e=>{void lookup(e);}} className="space-y-2">
          <label htmlFor="synthetic-licence" className="block text-xs font-medium">
            Synthetic licence number
          </label>
          <input id="synthetic-licence" type="text"
            value={licenceNumber} onChange={e=>setLicenceNumber(e.target.value)}
            maxLength={64} autoComplete="off" placeholder="ANCFZ-TEST-XXXX"
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            disabled={busy||conversationBusy}/>
          <button type="submit" disabled={busy||conversationBusy}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
            {busy?"Looking up…":"Validate licence number"}
          </button>
        </form>
      )}
      {error&&<p role="alert" className="text-xs text-red-700">{error}</p>}
    </section>
  );
}
