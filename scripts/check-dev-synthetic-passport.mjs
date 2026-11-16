#!/usr/bin/env node
/** Provider-free regression: an unnamed synthetic passport can only progress
 * in explicitly opted-in local development with independently extracted EID
 * billing name. No actual document bytes, OCR network or payment calls. */
import assert from "node:assert/strict";
import {
  parseIdentityResult,allowUnnamedSyntheticPassport,
} from "../services/api/dist/runtime/identity-extractor.js";
import {
  identityDocumentReadinessTx,assertIdentityDocumentsReadyTx,invoiceBillingName,
} from "../services/api/dist/runtime/purchase-operations.js";

const oldEnv={
  APP_ENV:process.env.APP_ENV,
  ANCFZ_DEV_ACCEPT_UNNAMED_PASSPORT:process.env.ANCFZ_DEV_ACCEPT_UNNAMED_PASSPORT,
};
function config(appEnv,allow) {
  process.env.APP_ENV=appEnv;
  process.env.ANCFZ_DEV_ACCEPT_UNNAMED_PASSPORT=allow;
}
const raw=(docType,fields)=>({
  status:"succeeded",
  analyzeResult:{documents:[{docType,fields}],content:""},
});
const field=valueString=>({valueString,confidence:0.97});
const passportNoName=raw("idDocument.passport",{
  FullName:field("Synthetic"),DocumentNumber:field("P12345"),
});
const passportTwoNames=raw("idDocument.passport",{
  FullName:field("Synthetic"),FirstName:field("Synthetic"),
  LastName:field("Tester"),DocumentNumber:field("P12345"),
});
const eidValid=raw("idDocument.uaeId",{
  FullName:field("Synthetic Tester"),DocumentNumber:field("784199900000001"),
});
const ids={agent:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ticket:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  intent:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  quote:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"};
const passport={requirement_key:"passport",state:"received",required:true,
  extraction_status:"pending",extraction_model:"prebuilt-idDocument",
  extracted_full_name:null};
const emirates={requirement_key:"emirates_id",state:"received",required:true,
  extraction_status:"extracted",extraction_model:"prebuilt-idDocument",
  extracted_full_name:"Synthetic Tester"};
const docs=[passport,emirates];
const db={
  query:async(sql)=>{
    if(sql.includes("FROM intent_document_requirements"))
      return {rows:docs};
    if(sql.includes("FROM tickets t"))
      return {rows:[{id:ids.quote,intent_id:ids.intent,
        purchase_enabled:true,state:"verified_completed"}]};
    throw Error("Unexpected test query: "+sql.slice(0,85));
  },
};
async function readiness(){
  return identityDocumentReadinessTx(db,ids.agent,ids.ticket,ids.intent);
}
try{
  config("development","false");
  assert.equal(allowUnnamedSyntheticPassport(),false);
  assert.throws(()=>parseIdentityResult(passportNoName,"passport",true));
  assert.equal(parseIdentityResult(passportTwoNames,"passport").fullName,"Synthetic Tester");
  assert.equal(parseIdentityResult(eidValid,"emirates_id").fullName,"Synthetic Tester");
  assert.deepEqual(await readiness(),{ready:false,missing:["passport"]});
  await assert.rejects(
    assertIdentityDocumentsReadyTx(db,ids.agent,ids.ticket,ids.intent),
  );

  config("development","true");
  assert.equal(allowUnnamedSyntheticPassport(),true);
  const extracted=parseIdentityResult(passportNoName,"passport",true);
  assert.equal(extracted.fullName,null);
  assert.equal(extracted.model,"prebuilt-idDocument");
  assert.deepEqual(await readiness(),{ready:true,missing:[]});
  assert.equal(await assertIdentityDocumentsReadyTx(db,ids.agent,ids.ticket,ids.intent),
    "Synthetic Tester");
  assert.equal(await invoiceBillingName(db,ids.agent,ids.ticket,ids.quote),
    "Synthetic Tester");

  passport.extracted_full_name="Different Person";
  passport.extraction_status="extracted";
  assert.deepEqual(await readiness(),{ready:false,missing:["identity_name_mismatch"]});
  passport.extracted_full_name=null;
  passport.extraction_status="pending";

  emirates.extracted_full_name=null;
  assert.deepEqual(await readiness(),{ready:false,missing:["emirates_id"]});
  emirates.extracted_full_name="Synthetic Tester";
  assert.throws(()=>parseIdentityResult(
    raw("idDocument.other",{FullName:field("Synthetic")}),"passport",true));
  assert.throws(()=>parseIdentityResult(
    raw("idDocument.uaeId",{FullName:field("Synthetic")}),"emirates_id",true));

  for(const env of ["production","staging","test"]){
    config(env,"true");
    assert.equal(allowUnnamedSyntheticPassport(),false);
    assert.throws(()=>parseIdentityResult(passportNoName,"passport",true));
    assert.deepEqual(await readiness(),{ready:false,missing:["passport"]});
  }
  console.log("Synthetic passport OCR fallback PASS: local-only; EID required; production fail-closed");
}finally{
  for(const [key,value] of Object.entries(oldEnv)){
    if(value===undefined)delete process.env[key];
    else process.env[key]=value;
  }
}
