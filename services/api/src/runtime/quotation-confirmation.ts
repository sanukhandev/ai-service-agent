/**
 * Quote-specific, Node-owned OTP gate before private document intake.
 * Independent of purchase/payment OTP. The mock n8n table is NOT a real email
 * delivery system and does not confer payment authorization.
 */
import {randomInt,randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {PersistenceDatabase,PersistenceError,requireUuid} from "../database/pool.js";
import {authorizedTicket,type TicketScope} from "../repositories/types.js";
import {appendEventTx} from "../repositories/events.js";
import {lifecycleNoticeId,TicketMessageRepository} from "../repositories/messages.js";
import {otpHmac,checkOtp,paymentEnabled} from "./payment-evidence.js";
import {QuotationOperations} from "./quotation-operations.js";
import {validateConversationFact} from "./fact-validation.js";

type ChallengeRow={
  id:string;quotation_id:string;request_id:string;state:string;email:string;
  otp_hmac:string;expires_at:Date;failed_attempts:number;created_at:Date;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function configured():void{
  if(!paymentEnabled() || process.env.ANCFZ_OTP_MOCK_ENABLED!=="true" ||
     !process.env.ANCFZ_OTP_PEPPER || process.env.ANCFZ_OTP_PEPPER.length<32)
    throw new PersistenceError("NOT_CONFIGURED","Sandbox quotation OTP is unavailable");
}
async function verifiedQuote(db:PersistenceDatabase,scope:TicketScope,ticketId:string,quoteId:string){
  const quote=await new QuotationOperations(db).get(scope,ticketId);
  if(!quote||quote.id!==quoteId||quote.state!=="verified_completed"||!quote.pdfAvailable)
    throw new PersistenceError("CONFLICT","A verified quotation PDF is required before confirmation");
  return quote;
}
export async function quoteConfirmedTx(
  client:PoolClient,agentId:string,ticketId:string,quotationId:string,
):Promise<boolean>{
  const result=await client.query(
    "SELECT 1 FROM ticket_quote_confirmation_otps WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3 AND state='verified' LIMIT 1",
    [agentId,ticketId,quotationId]);
  return (result.rowCount??result.rows.length)>0;
}
export class QuotationConfirmationOperations{
  constructor(private readonly db:PersistenceDatabase){}
  async read(scope:TicketScope,ticketId:string,quotationId:string){
    requireUuid(ticketId,"ticketId");requireUuid(quotationId,"quotationId");
    return this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId);
      const confirmed=await quoteConfirmedTx(client,scope.agentId,ticketId,quotationId);
      const latest=await client.query<ChallengeRow>(
        "SELECT id,quotation_id,state,expires_at FROM ticket_quote_confirmation_otps WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3 ORDER BY created_at DESC LIMIT 1",
        [scope.agentId,ticketId,quotationId]);
      const challenge=latest.rows[0];
      const contact=await client.query<{value:unknown;verification_status:string}>(
        "SELECT value,verification_status FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2 AND fact_key='customer_email'",
        [scope.agentId,ticketId]);
      const candidate=contact.rows[0];
      const decision=validateConversationFact("customer_email",candidate?.value as string,"email");
      const contactEmail=candidate?.verification_status!=="disputed"&&decision.status==="accepted"
        ?String(decision.value):null;
      return {verified:confirmed,contactEmail,
        challenge:challenge?{challengeId:challenge.id,state:challenge.state,
          expiresAt:challenge.expires_at.toISOString()}:null};
    });
  }
  async issue(scope:TicketScope,ticketId:string,raw:unknown){
    configured();
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Quote confirmation requires a quotation");
    const request=raw as Record<string,unknown>;
    if(Object.keys(request).some(k=>!["quotationId","requestId","confirmedEmail"].includes(k))||
       typeof request.quotationId!=="string"||!uuid.test(request.quotationId)||
       typeof request.requestId!=="string"||!uuid.test(request.requestId)||
       typeof request.confirmedEmail!=="string")
      throw new PersistenceError("INVALID_INPUT","Invalid quote OTP request");
    const quotationId=request.quotationId;
    const requestId=request.requestId;
    await verifiedQuote(this.db,scope,ticketId,quotationId);
    const pepper=process.env.ANCFZ_OTP_PEPPER as string;
    const code=String(randomInt(0,1000000)).padStart(6,"0");
    const challengeId=randomUUID();
    const initiated=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      if(await quoteConfirmedTx(client,scope.agentId,ticketId,quotationId))
        throw new PersistenceError("CONFLICT","Quotation has already been confirmed");
      const same=await client.query<ChallengeRow>(
        "SELECT id,quotation_id,state,expires_at FROM ticket_quote_confirmation_otps WHERE agent_id=$1 AND ticket_id=$2 AND request_id=$3",
        [scope.agentId,ticketId,requestId]);
      if(same.rows[0])
        throw new PersistenceError("CONFLICT","Quotation OTP request already processed; check its status");
      const rate=await client.query<{count:string;last:Date|null}>(
        "SELECT count(*)::text AS count,max(created_at) AS last FROM ticket_quote_confirmation_otps WHERE agent_id=$1 AND ticket_id=$2 AND created_at>now()-interval '1 hour'",
        [scope.agentId,ticketId]);
      if(Number(rate.rows[0]?.count??0)>=5||
         (rate.rows[0]?.last && Date.now()-rate.rows[0]!.last!.getTime()<60000))
        throw new PersistenceError("CONFLICT","Quote OTP request limit reached; retry after cooldown");
      const contact=await client.query<{value:unknown;verification_status:string}>(
        "SELECT value,verification_status FROM ticket_facts WHERE agent_id=$1 AND ticket_id=$2 AND fact_key='customer_email'",
        [scope.agentId,ticketId]);
      const fact=contact.rows[0];
      const decision=validateConversationFact("customer_email",fact?.value as string,"email");
      if(fact?.verification_status==="disputed"||decision.status!=="accepted")
        throw new PersistenceError("CONFLICT","Confirm your existing contact email with Sara before requesting quote OTP");
      const email=String(decision.value);
      if(email!==request.confirmedEmail.trim().toLowerCase())
        throw new PersistenceError("CONFLICT","Contact email changed; confirm the displayed address again");
      await client.query(
        "UPDATE ticket_quote_confirmation_otps SET state='expired' WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3 AND state IN ('pending','mock_recorded')",
        [scope.agentId,ticketId,quotationId]);
      const expires=new Date(Date.now()+5*60*1000);
      await client.query(
        "INSERT INTO ticket_quote_confirmation_otps(id,agent_id,ticket_id,quotation_id,request_id,email,otp_hmac,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [challengeId,scope.agentId,ticketId,quotationId,requestId,email,
          otpHmac(pepper,challengeId,code).toString("hex"),expires]);
      await appendEventTx(client,scope.agentId,ticketId,"quotation.confirmation.otp_requested",
        {quotationId,challengeId,expiresAt:expires.toISOString()});
      return {email,expiresAt:expires.toISOString()};
    });
    // The same bounded private sandbox recording mechanism as payment OTP.
    // On an ambiguous POST result, fail closed and NEVER auto-retry it.
    let recorded=false;
    const secret=process.env.ANCFZ_N8N_WEBHOOK_SECRET;
    if(secret && secret.length>=32){
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),20000);
      try{
        const response=await fetch("http://n8n:5678/webhook/ancfz/otp-email",{
          method:"POST",redirect:"error",signal:controller.signal,
          headers:{"Content-Type":"application/json","X-ANCFZ-Workflow-Key":secret},
          body:JSON.stringify({agentKey:"ancfz",ticketId,email:initiated.email,otp:code,
            testOnly:true,deliveryMode:"mock_datatable"}),
        });
        if(response.ok){
          const rawText=await response.text();
          if(rawText.length<=4096){
            const answer=JSON.parse(rawText) as Record<string,unknown>;
            recorded=answer.status==="mock_recorded"&&answer.testOnly===true&&
              answer.delivered===false;
          }
        }
      }catch{/* Never expose OTP or response; an uncertain POST cannot be retried. */}
      finally{clearTimeout(timeout);}
    }
    await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      await client.query(
        "UPDATE ticket_quote_confirmation_otps SET state=$4 WHERE agent_id=$1 AND ticket_id=$2 AND id=$3 AND state='pending'",
        [scope.agentId,ticketId,challengeId,recorded?"mock_recorded":"failed"]);
    });
    if(!recorded)
      throw new PersistenceError("CONFLICT","Quote OTP could not be confirmed in the test table; no documents are authorized");
    return {challengeId,quotationId,expiresAt:initiated.expiresAt,
      state:"mock_recorded",delivery:"n8n_test_table_only",realDelivery:false};
  }

  async verify(scope:TicketScope,ticketId:string,raw:unknown){
    configured();
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new PersistenceError("INVALID_INPUT","Secure quote OTP is required");
    const v=raw as Record<string,unknown>;
    if(Object.keys(v).some(k=>!["quotationId","challengeId","code"].includes(k))||
       typeof v.quotationId!=="string"||!uuid.test(v.quotationId)||
       typeof v.challengeId!=="string"||!uuid.test(v.challengeId)||
       typeof v.code!=="string"||!/^\d{6}$/.test(v.code))
      throw new PersistenceError("INVALID_INPUT","Invalid quote OTP input");
    await verifiedQuote(this.db,scope,ticketId,v.quotationId);
    const result=await this.db.withAgent(scope.agentId,async client=>{
      await authorizedTicket(client,scope,ticketId,true);
      if(await quoteConfirmedTx(client,scope.agentId,ticketId,v.quotationId as string))
        return {verified:true,duplicate:true};
      const row=await client.query<ChallengeRow>(
        "SELECT * FROM ticket_quote_confirmation_otps WHERE agent_id=$1 AND ticket_id=$2 AND quotation_id=$3 AND id=$4 FOR UPDATE",
        [scope.agentId,ticketId,v.quotationId,v.challengeId]);
      const challenge=row.rows[0];
      if(!challenge||challenge.state!=="mock_recorded"||
         challenge.expires_at.getTime()<=Date.now()||challenge.failed_attempts>=5)
        throw new PersistenceError("CONFLICT","Quote OTP expired or unavailable; request a new code");
      if(!checkOtp(process.env.ANCFZ_OTP_PEPPER as string,challenge.id,
          v.code as string,challenge.otp_hmac)){
        await client.query(
          "UPDATE ticket_quote_confirmation_otps SET failed_attempts=failed_attempts+1,state=CASE WHEN failed_attempts>=4 THEN 'failed' ELSE state END WHERE agent_id=$1 AND ticket_id=$2 AND id=$3",
          [scope.agentId,ticketId,challenge.id]);
        return {verified:false,reason:"OTP_INVALID"};
      }
      await client.query(
        "UPDATE ticket_quote_confirmation_otps SET state='verified',verified_at=now() WHERE agent_id=$1 AND ticket_id=$2 AND id=$3",
        [scope.agentId,ticketId,challenge.id]);
      await appendEventTx(client,scope.agentId,ticketId,"quotation.confirmation.verified",
        {quotationId:v.quotationId,challengeId:challenge.id});
      await new TicketMessageRepository(this.db).tryAssistantLifecycleNoticeTx(
        client,scope,ticketId,lifecycleNoticeId("quotation.otp.verified",challenge.id),
        "Your quotation confirmation code is verified. You can now upload your required synthetic identity documents privately in Secure transaction. Never share document files or OTPs in the chat.");
      return {verified:true,duplicate:false};
    });
    if(!result.verified)
      throw new PersistenceError("CONFLICT","Incorrect quote OTP; check the code in the private form");
    return result;
  }
}
