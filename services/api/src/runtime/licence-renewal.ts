/** Local-only ANCFZ licence renewal: read-only n8n Data Table lookup,
 * ticket-scoped snapshot and explicit acknowledgment. A lookup is NOT
 * licence-holder authentication, renewal approval or a payment authorization.
 */
import {createHash,randomUUID} from "node:crypto";
import {PersistenceDatabase,PersistenceError,requireUuid} from "../database/pool.js";
import {authorizedTicket,type TicketScope} from "../repositories/types.js";
import {appendEventTx} from "../repositories/events.js";

const licencePattern=/^ANCFZ-TEST-[A-Z0-9-]{4,40}$/;
const offeringPattern=/^renewal_[a-z0-9_]{1,110}$/;
const CONSENT="I confirm the displayed synthetic licence details and request a non-binding renewal quotation.";
export const RENEWAL_CONFIRMATION=CONSENT;
export const renewalEnabled=(env:NodeJS.ProcessEnv=process.env):boolean=>
  env.APP_ENV==="development"&&env.ANCFZ_RENEWAL_LOOKUP_ENABLED==="true"&&
  (env.ANCFZ_N8N_WEBHOOK_SECRET||"").length>=32;

type RenewalRow={
  licence_number:string;company_name:string;licence_status:string;
  expires_on:string;renewal_offering_key:string;renewal_term_years:number;
  source_fingerprint:string;state:"awaiting_confirmation"|"confirmed";
  looked_up_at:Date;confirmed_at:Date|null;fulfilment_state:string;
};
export type RenewalView={
  licenceNumber:string;companyName:string;status:string;expiresOn:string;
  offeringKey:string;termYears:number;fingerprint:string;
  confirmed:boolean;confirmationText:string;fulfilmentStatus:string;
};
export function validateLicenceNumber(input:unknown):string{
  if(typeof input!=="string" || !licencePattern.test(input.trim().toUpperCase()))
    throw new PersistenceError("INVALID_INPUT","Enter a synthetic ANCFZ-TEST licence number");
  return input.trim().toUpperCase();
}
export type LicenceResponse={
  status:"found"|"not_found"|"review";licenceNumber?:string;
  companyName?:string;licenceStatus?:string;expiresOn?:string;
  offeringKey?:string;termYears?:number;
};
export function validateLicenceResponse(raw:unknown,requested:string):LicenceResponse{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new PersistenceError("NOT_CONFIGURED","Renewal lookup returned an invalid response");
  const row=raw as Record<string,unknown>;
  if(row.status==="not_found"||row.status==="review")return {status:row.status};
  if(row.status!=="found"||row.licenceNumber!==requested||
    typeof row.companyName!=="string"||!row.companyName.trim()||
    row.companyName.length>200||
    !["active","expired","suspended","cancelled"].includes(String(row.licenceStatus))||
    typeof row.expiresOn!=="string"||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.expiresOn)||
    !Number.isFinite(Date.parse(row.expiresOn+"T00:00:00Z"))||
    new Date(row.expiresOn+"T00:00:00Z").toISOString().slice(0,10)!==row.expiresOn||
    typeof row.offeringKey!=="string"||!offeringPattern.test(row.offeringKey)||
    !Number.isInteger(row.termYears)||Number(row.termYears)<1||Number(row.termYears)>5)
    throw new PersistenceError("NOT_CONFIGURED","Invalid licence data returned by renewal lookup");
  return {
    status:"found",licenceNumber:requested,
    companyName:row.companyName.trim(),licenceStatus:String(row.licenceStatus),
    expiresOn:row.expiresOn,offeringKey:row.offeringKey,
    termYears:Number(row.termYears),
  };
}
function view(row:RenewalRow):RenewalView{
  return {licenceNumber:row.licence_number,companyName:row.company_name,
    status:row.licence_status,expiresOn:row.expires_on,
    offeringKey:row.renewal_offering_key,termYears:row.renewal_term_years,
    fingerprint:row.source_fingerprint,
    confirmed:row.state==="confirmed",confirmationText:CONSENT,
    fulfilmentStatus:row.fulfilment_state??"not_requested"};
}
const lookupSql=`SELECT licence_number,company_name,licence_status,
  expires_on::text AS expires_on,renewal_offering_key,renewal_term_years,
  source_fingerprint,state,looked_up_at,confirmed_at,fulfilment_state
  FROM ticket_licence_renewals WHERE agent_id=$1 AND ticket_id=$2`;

export class LicenceRenewalOperations{
  constructor(private readonly db:PersistenceDatabase){}
  async read(scope:TicketScope,ticketId:string):Promise<{
    enabled:boolean;applicable:boolean;record:RenewalView|null;
  }>{
    requireUuid(ticketId,"ticketId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const intent=await client.query<{intent_key:string}>(
        `SELECT i.intent_key FROM tickets t JOIN ticket_intents ti
         ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active'
         JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
           AND i.catalog_version_id=t.intent_catalog_version_id
         WHERE t.agent_id=$1 AND t.id=$2 LIMIT 1`,
        [scope.agentId,ticketId],
      );
      const applicable=intent.rows[0]?.intent_key==="license_renewal";
      if(!applicable)return {enabled:renewalEnabled(),applicable:false,record:null};
      const record=await client.query<RenewalRow>(lookupSql,[scope.agentId,ticketId]);
      return {enabled:renewalEnabled(),applicable:true,
        record:record.rows[0]?view(record.rows[0]):null};
    });
  }
  async lookup(scope:TicketScope,ticketId:string,raw:unknown):Promise<RenewalView>{
    requireUuid(ticketId,"ticketId");
    if(!renewalEnabled())
      throw new PersistenceError("NOT_CONFIGURED","Synthetic licence renewal lookup is disabled");
    if(!raw||typeof raw!=="object"||Array.isArray(raw)||
       Object.keys(raw).some(x=>x!=="licenceNumber"))
      throw new PersistenceError("INVALID_INPUT","Licence lookup request required");
    const licenceNumber=validateLicenceNumber((raw as Record<string,unknown>).licenceNumber);
    await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const selected=await client.query<{intent_key:string}>(
        `SELECT i.intent_key FROM tickets t JOIN ticket_intents ti
         ON ti.agent_id=t.agent_id AND ti.ticket_id=t.id AND ti.status='active'
         JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
           AND i.catalog_version_id=t.intent_catalog_version_id
         WHERE t.agent_id=$1 AND t.id=$2 LIMIT 1`,
        [scope.agentId,ticketId],
      );
      if(selected.rows[0]?.intent_key!=="license_renewal")
        throw new PersistenceError("CONFLICT","Select the licence renewal service first");
      const prior=await client.query<{state:string}>(
        "SELECT state FROM ticket_licence_renewals WHERE agent_id=$1 AND ticket_id=$2 FOR UPDATE",
        [scope.agentId,ticketId],
      );
      if(prior.rows[0]?.state==="confirmed")
        throw new PersistenceError("CONFLICT","Confirmed renewal details are locked");
      const attempts=await client.query<{n:string}>(
        `SELECT count(*)::text AS n FROM ticket_events
         WHERE agent_id=$1 AND ticket_id=$2
           AND event_type='renewal.lookup.attempt'
           AND created_at>now()-interval '1 hour'`,
        [scope.agentId,ticketId],
      );
      if(Number(attempts.rows[0]?.n??0)>=5)
        throw new PersistenceError("CONFLICT","Too many licence lookups; request staff review");
      await appendEventTx(client,scope.agentId,ticketId,"renewal.lookup.attempt",{
        source:"secure_customer_form",
      });
    });
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET!;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    let parsed:unknown;
    try{
      const response=await fetch("http://n8n:5678/webhook/ancfz/renewal-lookup",{
        method:"POST",redirect:"error",signal:controller.signal,
        headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
        body:JSON.stringify({agentKey:"ancfz",ticketId,licenceNumber}),
      });
      if(!response.ok)throw Error("n8n error");
      const txt=await response.text();
      if(txt.length>4000)throw Error("response oversized");
      parsed=JSON.parse(txt);
    }catch{
      throw new PersistenceError("NOT_CONFIGURED","Licence renewal lookup is temporarily unavailable");
    }finally{clearTimeout(timer);}
    const item=validateLicenceResponse(parsed,licenceNumber);
    if(item.status!=="found")
      throw new PersistenceError("NOT_FOUND","Licence not found or requires staff review");
    if(!["active","expired"].includes(item.licenceStatus!))
      throw new PersistenceError("CONFLICT","This licence requires staff review before renewal");
    const snapshot={licenceNumber:item.licenceNumber,companyName:item.companyName,
      status:item.licenceStatus,expiresOn:item.expiresOn,
      offeringKey:item.offeringKey,termYears:item.termYears};
    const fingerprint=createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const result=await client.query<RenewalRow>(
        `INSERT INTO ticket_licence_renewals(
          agent_id,ticket_id,licence_number,company_name,licence_status,
          expires_on,renewal_offering_key,renewal_term_years,source_fingerprint
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(agent_id,ticket_id) DO UPDATE SET
          licence_number=EXCLUDED.licence_number,company_name=EXCLUDED.company_name,
          licence_status=EXCLUDED.licence_status,expires_on=EXCLUDED.expires_on,
          renewal_offering_key=EXCLUDED.renewal_offering_key,
          renewal_term_years=EXCLUDED.renewal_term_years,
          source_fingerprint=EXCLUDED.source_fingerprint,
          state='awaiting_confirmation',confirmed_at=NULL,confirmed_request_id=NULL,
          looked_up_at=now()
        WHERE ticket_licence_renewals.state<>'confirmed'
        RETURNING *`,
        [scope.agentId,ticketId,licenceNumber,item.companyName,item.licenceStatus,
          item.expiresOn,item.offeringKey,item.termYears,fingerprint],
      );
      if(!result.rows[0])throw new PersistenceError("CONFLICT","Renewal confirmation is locked");
      await appendEventTx(client,scope.agentId,ticketId,"renewal.lookup.matched",{
        licenceLast4:licenceNumber.slice(-4),offeringKey:item.offeringKey,
      });
      return view(result.rows[0]);
    });
  }
  async confirm(scope:TicketScope,ticketId:string,raw:unknown):Promise<RenewalView>{
    requireUuid(ticketId,"ticketId");
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Renewal confirmation required");
    const body=raw as Record<string,unknown>;
    if(Object.keys(body).some(k=>!["requestId","fingerprint","consentText"].includes(k))||
       typeof body.requestId!=="string"||
       typeof body.fingerprint!=="string"||!(/^[a-f0-9]{64}$/).test(body.fingerprint)||
       body.consentText!==CONSENT)
      throw new PersistenceError("INVALID_INPUT","Exact renewal details confirmation required");
    const requestId=requireUuid(body.requestId,"requestId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      const locked=await client.query<RenewalRow>(
        lookupSql+" FOR UPDATE",[scope.agentId,ticketId]);
      const record=locked.rows[0];
      if(!record||record.source_fingerprint!==body.fingerprint)
        throw new PersistenceError("CONFLICT","Renewal details changed; look up again");
      if(record.state==="confirmed"){
        if((await client.query<{confirmed_request_id:string}>(
          "SELECT confirmed_request_id FROM ticket_licence_renewals WHERE agent_id=$1 AND ticket_id=$2",
          [scope.agentId,ticketId])).rows[0]?.confirmed_request_id!==requestId)
          throw new PersistenceError("CONFLICT","Renewal already confirmed");
        return view(record);
      }
      if(Date.now()-new Date(record.looked_up_at).getTime()>15*60*1000)
        throw new PersistenceError("CONFLICT","Renewal lookup expired; look up again");
      if(!["active","expired"].includes(record.licence_status))
        throw new PersistenceError("CONFLICT","Licence is not eligible for sandbox renewal");
      const changed=await client.query<RenewalRow>(
        `UPDATE ticket_licence_renewals SET state='confirmed',confirmed_at=now(),
         confirmed_request_id=$3 WHERE agent_id=$1 AND ticket_id=$2
         RETURNING *`,[scope.agentId,ticketId,requestId],
      );
      await appendEventTx(client,scope.agentId,ticketId,"renewal.details.confirmed",{
        licenceLast4:record.licence_number.slice(-4),offeringKey:record.renewal_offering_key,
        sourceFingerprint:record.source_fingerprint,
      });
      return view(changed.rows[0]);
    });
  }
}
