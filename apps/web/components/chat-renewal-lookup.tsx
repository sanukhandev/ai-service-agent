"use client";

import {useRef,useState,type FormEvent} from "react";

type Rate={offeringKey:string;label:string;amount:string;currency:string;priceRevision:number};
type Preview={available:boolean;reason:string|null;contractNumber:string;
  nextRevision:number;disclosure:string;options:Rate[]};
type Lookup={licenceNumber:string;sourceTicketId:string;sourceContractId:string;
  preview:Preview};

async function postJson<T>(path:string,body:object):Promise<T>{
  const response=await fetch(path,{method:"POST",credentials:"include",cache:"no-store",
    headers:{Accept:"application/json","Content-Type":"application/json"},
    body:JSON.stringify(body)});
  let json:unknown;
  try{json=await response.json();}catch{throw Error("Unexpected response from service");}
  if(!response.ok){
    const message=(json as {message?:unknown})?.message;
    throw Error(typeof message==="string"?message:"TEST renewal request rejected");
  }
  return json as T;
}

/** A ticket-owned interaction in the chat transcript, not a separate dashboard.
 * Licence number is a synthetic alias. No real licence or customer details
 * are sent to the model; n8n never authorizes payment or renewal.
 */
export function ChatRenewalLookup({ticketId,conversationBusy,onRenewalCreated}:{
  ticketId:string;conversationBusy:boolean;onRenewalCreated:(ticketId:string)=>void;
}){
  const [licenceNumber,setLicenceNumber]=useState("");
  const [result,setResult]=useState<Lookup|null>(null);
  const [offering,setOffering]=useState("");
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState<"lookup"|"start"|null>(null);
  const [error,setError]=useState<string|null>(null);
  const requestId=useRef<string|null>(null);
  const rate=result?.preview.options.find(x=>x.offeringKey===offering);

  async function lookup(e:FormEvent<HTMLFormElement>){
    e.preventDefault();
    if(busy||conversationBusy)return;
    setBusy("lookup");setError(null);setResult(null);setConsent(false);
    requestId.current=null;
    try{
      const data=await postJson<Lookup>(
        "/api/v1/tickets/"+encodeURIComponent(ticketId)+"/renewal/lookup",
        {licenceNumber:licenceNumber.trim().toUpperCase()});
      setResult(data);setOffering(data.preview.options[0]?.offeringKey??"");
    }catch(e){setError(e instanceof Error?e.message:"Could not verify TEST licence");}
    finally{setBusy(null);}
  }
  async function submit(){
    if(!result||!result.preview.available||!rate||!consent||busy||conversationBusy)return;
    setBusy("start");setError(null);
    const id=requestId.current??crypto.randomUUID();
    requestId.current=id;
    try{
      const path="/api/v1/tickets/"+encodeURIComponent(result.sourceTicketId)+
        "/contracts/"+encodeURIComponent(result.sourceContractId)+"/renewal/start";
      const created=await postJson<{ticketId:string}>(path,{
        requestId:id,offeringKey:rate.offeringKey,priceRevision:rate.priceRevision,
        amount:rate.amount,currency:rate.currency,consent:true,
        consentText:result.preview.disclosure,
      });
      requestId.current=null;
      onRenewalCreated(created.ticketId);
    }catch(e){setError(e instanceof Error?e.message:"Unable to start TEST renewal");}
    finally{setBusy(null);}
  }

  return (
    <details className="mt-5 w-full max-w-xl rounded-2xl border border-zinc-200 bg-white p-4 text-sm shadow-xs">
      <summary className="cursor-pointer font-semibold text-zinc-900">
        Renew an existing ANCFZ TEST licence
      </summary>
      <p className="mt-2 text-xs text-zinc-600">
        Sandbox only. Enter the TEST alias of your verified agreement
        (example: ANCFZ-TEST-SC-2026-000001). This is not a government-issued
        licence lookup or an actual renewal.
      </p>
      <form onSubmit={e=>{void lookup(e);}} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input type="text" aria-label="Synthetic licence number" maxLength={30}
          placeholder="ANCFZ-TEST-SC-2026-000001" value={licenceNumber}
          pattern="ANCFZ-TEST-SC-[0-9]{4}-[0-9]{6}"
          onChange={e=>{setLicenceNumber(e.target.value.toUpperCase());
            setResult(null);setConsent(false);requestId.current=null;}}
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2 font-mono text-xs"
          required />
        <button type="submit" disabled={busy!==null||conversationBusy}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
          {busy==="lookup"?"Checking n8n…":"Verify TEST licence"}
        </button>
      </form>
      {result && (
        <div className="mt-3 space-y-3 border-t border-zinc-200 pt-3">
          <p className="text-xs font-semibold text-zinc-800">
            Verified TEST agreement: {result.preview.contractNumber},
            proposed revision {result.preview.nextRevision}
          </p>
          {!result.preview.available ? (
            <p className="text-xs text-zinc-700">
              {result.preview.reason??"No renewal-specific TEST prices published."}
            </p>
          ) : (
            <>
              <label className="block text-xs font-medium text-zinc-700">
                Synthetic TEST renewal quote
                <select value={offering}
                  onChange={e=>{setOffering(e.target.value);setConsent(false);requestId.current=null;}}
                  className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white p-2">
                  {result.preview.options.map(option=>(
                    <option key={option.offeringKey} value={option.offeringKey}>
                      {option.label} — {option.currency} {option.amount}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs font-semibold text-amber-800">
                TEST prices only; not approved ANCFZ rates or regulatory fees.
              </p>
              <label className="flex items-start gap-2 text-xs text-zinc-700">
                <input type="checkbox" className="mt-0.5" checked={consent}
                  onChange={e=>setConsent(e.target.checked)} />
                <span>{result.preview.disclosure}</span>
              </label>
              <button type="button" onClick={()=>{void submit();}}
                disabled={!consent||!rate||busy!==null||conversationBusy}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">
                {busy==="start"?"Recording authorization…":"Approve TEST renewal quotation"}
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p>}
    </details>
  );
}
