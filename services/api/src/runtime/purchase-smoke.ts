/** Disposable P3 CI only. No merchant, Foundry, OCR or n8n requests. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PersistenceDatabase, PersistenceError } from "../database/pool.js";
import { AgentRepository } from "../repositories/agent.js";
import { workerTicketScope } from "../repositories/types.js";
import { PurchaseOperations, PURCHASE_CONSENT, assertPurchaseReady, invoiceBillingName } from "./purchase-operations.js";
import { parseIdentityResult, nameKey } from "./identity-extractor.js";
import { QuotationOperations } from "./quotation-operations.js";

async function run(){
  if(process.env.P5_PURCHASE_OFFLINE_SMOKE!=="1")throw Error("CI only");
  const ticketId=process.env.P3_TEST_TICKET;
  if(!ticketId)throw Error("Missing disposable ticket");
  const db=new PersistenceDatabase(undefined);
  try{
    await db.assertSafeRuntimeRole();
    const agent=await new AgentRepository(db).resolvePublicKey("ancfz");
    assert.ok(agent);
    const scope=workerTicketScope(agent.id,ticketId);
    const purchases=new PurchaseOperations(db,async(_bytes,kind)=>({
      fullName:"TEST SANDBOX PERSON",
      documentNumberLast4:kind==="passport"?"P123":"E456",
      model:"prebuilt-idDocument" as const,
    }));
    const conflictForParser=(err:unknown)=>err instanceof PersistenceError&&err.code==="CONFLICT";
    const sample={status:"succeeded",analyzeResult:{documents:[{docType:"idDocument.passport",fields:{
      FirstName:{valueString:"TEST"},LastName:{valueString:"SANDBOX PERSON"},
      DocumentNumber:{valueString:"P123456"},
    }}]}};
    assert.equal(parseIdentityResult(sample,"passport").fullName,"TEST SANDBOX PERSON");
    const emiratesSample={status:"succeeded",analyzeResult:{
      content:"Emirates ID 784-1990-1234567-1",
      documents:[{docType:"idDocument.generic",fields:{
        FirstName:{valueString:"TEST"},LastName:{valueString:"SANDBOX PERSON"},
      }}],
    }};
    assert.equal(parseIdentityResult(emiratesSample,"emirates_id").documentNumberLast4,"5671");
    await assert.rejects(async()=>parseIdentityResult(sample,"emirates_id"),conflictForParser);
    await assert.rejects(async()=>parseIdentityResult({
      ...emiratesSample,analyzeResult:{...emiratesSample.analyzeResult,
        content:"not a recognized Emirates ID number"},
    },"emirates_id"),conflictForParser);
    assert.equal(nameKey("PERSON TEST SANDBOX"),nameKey("TEST SANDBOX PERSON"));
    const quoted=await new QuotationOperations(db).get(scope,ticketId);
    assert.ok(quoted);
    const before=await purchases.read(scope,ticketId);
    assert.equal(before.supported,true);
    assert.equal(before.intentKey,"company_formation");
    assert.deepEqual(before.requirements.map(d=>d.key),["passport","emirates_id"]);
    assert.equal(before.confirmed,false);
    assert.equal(before.readyForOtp,false);
    const consent={
      requestId:randomUUID(),quotationId:quoted.id,
      amount:quoted.amount,currency:"AED",consent:true,consentText:PURCHASE_CONSENT,
    };
    const conflict=(err:unknown)=>err instanceof PersistenceError && err.code==="CONFLICT";
    await assert.rejects(()=>purchases.confirm(scope,ticketId,consent),conflict);
    await db.withAgent(agent.id,async client=>{
      const proof=Buffer.from("%PDF-1.4\n"+(" ".repeat(256))+"\n%%EOF\n");
      await client.query(
        `UPDATE ticket_operations SET state='verified_completed',provider_status='ci_synthetic'
          WHERE agent_id=$1 AND ticket_id=$2 AND operation_key='ancfz_render_quote'`,
        [agent.id,ticketId],
      );
      await client.query(
        `INSERT INTO ticket_quotation_pdfs(agent_id,ticket_id,quotation_id,bytes,sha256)
          VALUES($1,$2,$3,$4,$5)`,
        [agent.id,ticketId,quoted.id,proof,createHash("sha256").update(proof).digest("hex")],
      );
      await assert.rejects(()=>assertPurchaseReady(client,agent.id,ticketId,quoted.id),conflict);
    });
    // Quote confirmation is a separate OTP gate for document collection.
    // This is isolated CI evidence, never a provider/OTP bypass in runtime.
    await assert.rejects(()=>purchases.upload(scope,ticketId,{
      requirementKey:"passport",fileName:"blocked.pdf",
      contentType:"application/pdf",
      dataBase64:Buffer.from("%PDF-1.4\\n"+("A".repeat(260))+"\\n%%EOF\\n").toString("base64"),
    }),conflict);
    await db.withAgent(agent.id,async client=>{
      await client.query(
        "INSERT INTO ticket_quote_confirmation_otps(agent_id,ticket_id,quotation_id,request_id,email,otp_hmac,state,expires_at,verified_at) VALUES($1,$2,$3,$4,$5,$6,'verified',now()+interval '5 minutes',now())",
        [agent.id,ticketId,quoted.id,randomUUID(),"ci@example.invalid","a".repeat(64)],
      );
    });
    const doc1=Buffer.from("%PDF-1.4\n"+("A".repeat(260))+"\n%%EOF\n");
    const doc2=Buffer.from("%PDF-1.4\n"+("B".repeat(260))+"\n%%EOF\n");
    const correctedPassport=Buffer.from("%PDF-1.4\n"+("C".repeat(260))+"\n%%EOF\n");
    const upload=async (requirementKey:string,bytes:Buffer)=>purchases.upload(scope,ticketId,{
      requirementKey,fileName:requirementKey+".pdf",
      contentType:"application/pdf",dataBase64:bytes.toString("base64"),
    });
    const first=await upload("passport",doc1);
    assert.equal(first.duplicated,false);
    assert.equal((await upload("passport",doc1)).duplicated,true);
    const replaced=await upload("passport",correctedPassport);
    assert.equal(replaced.replaced,true);
    assert.equal(replaced.documentId,first.documentId);
    const audit=await db.withAgent(agent.id,async client=>{
      const row=await client.query<{payload:{previousSha256:string;sha256:string}}>(
        "SELECT payload FROM ticket_events WHERE agent_id=$1 AND ticket_id=$2 AND event_type='purchase.document.replaced' ORDER BY sequence DESC LIMIT 1",
        [agent.id,ticketId],
      );
      return row.rows[0]?.payload;
    });
    assert.equal(audit?.previousSha256,createHash("sha256").update(doc1).digest("hex"));
    assert.equal(audit?.sha256,createHash("sha256").update(correctedPassport).digest("hex"));
    await assert.rejects(()=>purchases.confirm(scope,ticketId,consent),conflict);
    const second=await upload("emirates_id",doc2);
    assert.ok(second.documentId);
    // UI checklist links must use the uploaded document row ID, never
    // intent_document_requirements.id (which cannot be downloaded).
    const checklist=await purchases.read(scope,ticketId);
    assert.equal(checklist.requirements.find(d=>d.key==="passport")?.documentId,first.documentId);
    assert.equal(checklist.requirements.find(d=>d.key==="emirates_id")?.documentId,second.documentId);
    assert.equal(checklist.requirements.find(d=>d.key==="passport")?.uploaded,true);
    assert.equal(checklist.requirements.find(d=>d.key==="emirates_id")?.uploaded,true);
    const downloaded=await purchases.download(scope,ticketId,
      checklist.requirements.find(d=>d.key==="passport")?.documentId??"");
    assert(downloaded.bytes.equals(correctedPassport));
    await assert.rejects(()=>purchases.confirm(scope,ticketId,{...consent,amount:"1.00"}),conflict);
    const created=await purchases.confirm(scope,ticketId,consent);
    assert.equal(created.confirmed,true);
    assert.equal(created.duplicated,false);
    assert.equal((await purchases.confirm(scope,ticketId,consent)).duplicated,true);
    await assert.rejects(()=>purchases.confirm(scope,ticketId,{...consent,requestId:randomUUID()}),conflict);
    await assert.rejects(()=>upload("passport",doc1),conflict);
    await db.withAgent(agent.id,async client=>{
      await assertPurchaseReady(client,agent.id,ticketId,quoted.id);
      assert.equal(await invoiceBillingName(client,agent.id,ticketId,quoted.id),"TEST SANDBOX PERSON");
    });
    const status=await purchases.read(scope,ticketId);
    assert.equal(status.readyForOtp,true);
    assert.equal(status.missing.length,0);
    assert.equal(status.confirmed,true);
    assert.equal(status.billingName,"TEST SANDBOX PERSON");
    assert(!JSON.stringify(status).includes(doc1.toString("base64")));
    console.log("P5 purchase DB smoke PASS: passport/Emirates ID OCR fields, matched invoice billing name, consent and OTP gate");
  }finally{await db.close();}
}
run().catch(err=>{console.error(err);process.exitCode=1;});
