#!/usr/bin/env node
/** No real n8n, licence holders, Salesforce, payment or OTP; synthetic only. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {
  LicenceRenewalOperations,RENEWAL_CONFIRMATION,renewalEnabled,
  validateLicenceNumber,validateLicenceResponse,
} from "../services/api/dist/runtime/licence-renewal.js";
import {requestedBusinessAction} from
  "../services/api/dist/runtime/conversation-action-handoff.js";
import {workerTicketScope} from "../services/api/dist/repositories/types.js";

const input={status:"found",licenceNumber:"ANCFZ-TEST-0001",
  companyName:"Example Synthetic Licence LLC",licenceStatus:"active",
  expiresOn:"2027-12-31",offeringKey:"renewal_standard_y1",termYears:1};
const requestId=randomUUID();
assert.equal(validateLicenceNumber("ancfz-test-0001"),"ANCFZ-TEST-0001");
assert.throws(()=>validateLicenceNumber("ANCFZ-REAL-1234"));
assert.throws(()=>validateLicenceNumber("12345"));
assert.deepEqual(validateLicenceResponse(input,input.licenceNumber),input);
for(const patch of [{companyName:""},{licenceNumber:"ANCFZ-TEST-9999"},
  {offeringKey:"visa_1_y1"},{termYears:0},{status:"paid"},
  {expiresOn:"yesterday"}]){
  assert.throws(()=>validateLicenceResponse({...input,...patch},input.licenceNumber));
}
assert.deepEqual(validateLicenceResponse({status:"not_found"},input.licenceNumber),{
  status:"not_found",
});
assert.equal(renewalEnabled({
  APP_ENV:"production",ANCFZ_RENEWAL_LOOKUP_ENABLED:"true",
  ANCFZ_N8N_WEBHOOK_SECRET:"a".repeat(32),
}),false);
assert.equal(renewalEnabled({
  APP_ENV:"development",ANCFZ_RENEWAL_LOOKUP_ENABLED:"true",
  ANCFZ_N8N_WEBHOOK_SECRET:"a".repeat(32),
}),true);
assert.equal(requestedBusinessAction(
  "I want to renew my existing ANCFZ licence"),"generate_quote");

const flow=JSON.parse(readFileSync(
  "infra/n8n/ancfz/07-licence-renewal-lookup.json","utf8"));
assert.equal(flow.active,false);
assert.equal(flow.settings.saveDataSuccessExecution,"none");
const get=flow.nodes.find(x=>x.name==="Get Matching Licence Rows");
assert.equal(get.type,"n8n-nodes-base.dataTable");
assert.equal(get.parameters.operation,"get");
assert.equal(get.parameters.dataTableId.value,"ANCFZ_POC_LICENCES");
assert.equal(get.parameters.matchType,"allConditions");
assert.deepEqual(get.parameters.filters.conditions,[{
  keyName:"licenceNumber",condition:"eq",
  keyValue:"={{ $json.licenceNumber }}",
}]);
assert.equal(get.parameters.limit,2);
assert.equal(get.alwaysOutputData,true);
assert(!flow.nodes.some(x=>["insert","upsert","update","deleteRows"].includes(x.parameters?.operation)));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const code=flow.nodes.find(x=>x.name==="Sanitize Licence Lookup").parameters.jsCode;
const parsed=await new AsyncFunction("$input","$",code)(
  {all:()=>[{json:input}]},
  ()=>({first:()=>({json:{licenceNumber:input.licenceNumber}})}),
);
assert.deepEqual(parsed[0].json,input);
const duplicate=await new AsyncFunction("$input","$",code)(
  {all:()=>[{json:input},{json:input}]},
  ()=>({first:()=>({json:{licenceNumber:input.licenceNumber}})}),
);
assert.equal(duplicate[0].json.status,"review");

const agentId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ticketId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope=workerTicketScope(agentId,ticketId);
let record=null,attempts=0,seq=0;
const events=[];
const db={withAgent:async(id,fn)=>{
  assert.equal(id,agentId);
  return fn({query:async(sql,params=[])=>{
    if(sql.includes("SELECT * FROM tickets WHERE agent_id"))
      return {rows:[{id:ticketId,status:"open"}]};
    if(sql.includes("SELECT i.intent_key FROM tickets"))
      return {rows:[{intent_key:"license_renewal"}]};
    if(sql.includes("SELECT state FROM ticket_licence_renewals"))
      return {rows:record?[{state:record.state}]:[]};
    if(sql.includes("SELECT count(*)::text AS n FROM ticket_events"))
      return {rows:[{n:String(attempts)}]};
    if(sql.includes("UPDATE tickets SET last_event_sequence")){
      seq++;
      return {rows:[{last_event_sequence:String(seq)}]};
    }
    if(sql.includes("INSERT INTO ticket_events")){
      const event={id:randomUUID(),ticket_id:ticketId,sequence:String(seq),
        event_type:params[3],payload:JSON.parse(params[4]),created_at:new Date()};
      events.push(event);
      if(event.event_type==="renewal.lookup.attempt")attempts++;
      return {rows:[event]};
    }
    if(sql.includes("INSERT INTO ticket_licence_renewals")){
      record={licence_number:params[2],company_name:params[3],
        licence_status:params[4],expires_on:params[5],
        renewal_offering_key:params[6],renewal_term_years:params[7],
        source_fingerprint:params[8],state:"awaiting_confirmation",
        looked_up_at:new Date(),confirmed_at:null,confirmed_request_id:null};
      return {rows:[record]};
    }
    if(sql.includes("FROM ticket_licence_renewals WHERE")){
      return {rows:record?[record]:[],rowCount:record?1:0};
    }
    if(sql.includes("UPDATE ticket_licence_renewals SET state='confirmed'")){
      record={...record,state:"confirmed",confirmed_at:new Date(),confirmed_request_id:params[2]};
      return {rows:[record]};
    }
    if(sql.includes("SELECT confirmed_request_id FROM ticket_licence_renewals"))
      return {rows:[{confirmed_request_id:record?.confirmed_request_id}]};
    throw Error("Unexpected SQL: "+sql.slice(0,100));
  }});
}};
const envKeys=["APP_ENV","ANCFZ_RENEWAL_LOOKUP_ENABLED","ANCFZ_N8N_WEBHOOK_SECRET"];
const oldEnv=Object.fromEntries(envKeys.map(x=>[x,process.env[x]]));
const oldFetch=globalThis.fetch;
try{
  Object.assign(process.env,{
    APP_ENV:"development",ANCFZ_RENEWAL_LOOKUP_ENABLED:"true",
    ANCFZ_N8N_WEBHOOK_SECRET:"z".repeat(32),
  });
  globalThis.fetch=async(url,opts)=>{
    assert.equal(url,"http://n8n:5678/webhook/ancfz/renewal-lookup");
    assert.equal(opts.method,"POST");
    assert.equal(opts.headers["X-ANCFZ-Workflow-Key"],"z".repeat(32));
    assert.equal(JSON.parse(opts.body).licenceNumber,input.licenceNumber);
    return {ok:true,text:async()=>JSON.stringify(input)};
  };
  const flow=new LicenceRenewalOperations(db);
  assert.equal((await flow.read(scope,ticketId)).applicable,true);
  assert.equal((await flow.read(scope,ticketId)).record,null);
  const looked=await flow.lookup(scope,ticketId,{licenceNumber:input.licenceNumber});
  assert.equal(looked.confirmed,false);
  assert.equal(looked.companyName,input.companyName);
  assert(!events.some(x=>JSON.stringify(x.payload).includes(input.companyName)));
  await assert.rejects(flow.confirm(scope,ticketId,{
    requestId,fingerprint:"0".repeat(64),consentText:RENEWAL_CONFIRMATION,
  }));
  const done=await flow.confirm(scope,ticketId,{
    requestId,fingerprint:looked.fingerprint,consentText:RENEWAL_CONFIRMATION,
  });
  assert.equal(done.confirmed,true);
  assert.equal((await flow.read(scope,ticketId)).record.confirmed,true);
  assert.equal((await flow.confirm(scope,ticketId,{
    requestId,fingerprint:looked.fingerprint,consentText:RENEWAL_CONFIRMATION,
  })).confirmed,true);
  await assert.rejects(flow.lookup(scope,ticketId,{licenceNumber:input.licenceNumber}));
  assert(!events.some(x=>/invoice|payment|order|renewed/.test(x.event_type)));
  console.log("Synthetic licence renewal PASS: exact match, confirmation, locked snapshot, no payment dispatch");
}finally{
  globalThis.fetch=oldFetch;
  for(const k of envKeys)oldEnv[k]===undefined?delete process.env[k]:process.env[k]=oldEnv[k];
}
