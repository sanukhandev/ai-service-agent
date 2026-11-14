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
    const sample={status:"succeeded",analyzeResult:{documents:[{fields:{
      FirstName:{valueString:"TEST"},LastName:{valueString:"SANDBOX PERSON"},
      DocumentNumber:{valueString:"P123456"},
    }}]}};
    assert.equal(parseIdentityResult(sample,"passport").fullName,"TEST SANDBOX PERSON");
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
    const doc1=Buffer.from("%PDF-1.4\n"+("A".repeat(260))+"\n%%EOF\n");
    const doc2=Buffer.from("%PDF-1.4\n"+("B".repeat(260))+"\n%%EOF\n");
    const upload=async (requirementKey:string,bytes:Buffer)=>purchases.upload(scope,ticketId,{
      requirementKey,fileName:requirementKey+".pdf",
      contentType:"application/pdf",dataBase64:bytes.toString("base64"),
    });
    const first=await upload("passport",doc1);
    assert.equal(first.duplicated,false);
    assert.equal((await upload("passport",doc1)).duplicated,true);
    await assert.rejects(()=>upload("passport",doc2),conflict);
    await assert.rejects(()=>purchases.confirm(scope,ticketId,consent),conflict);
    const second=await upload("emirates_id",doc2);
    assert.ok(second.documentId);
    const downloaded=await purchases.download(scope,ticketId,first.documentId);
    assert(downloaded.bytes.equals(doc1));
    await assert.rejects(()=>purchases.confirm(scope,ticketId,{...consent,amount:"1.00"}),conflict);
    const created=await purchases.confirm(scope,ticketId,consent);
    assert.equal(created.confirmed,true);
    assert.equal(created.duplicated,false);
    assert.equal((await purchases.confirm(scope,ticketId,consent)).duplicated,true);
    await assert.rejects(()=>purchases.confirm(scope,ticketId,{...consent,requestId:randomUUID()}),conflict);
    await assert.rejects(()=>upload("shareholder_identity_pack",doc1),conflict);
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
