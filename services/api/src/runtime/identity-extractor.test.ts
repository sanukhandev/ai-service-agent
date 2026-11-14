import test from "node:test";
import assert from "node:assert/strict";
import { parseGeminiVisionResult } from "./identity-extractor.js";
test("synthetic Gemini OCR: accept a well-formed passport",()=>{
  assert.deepEqual(parseGeminiVisionResult({
    documentType:"passport",readable:true,fullName:"Ada Example",
    documentNumber:"P1234567",
  },"passport"),{fullName:"Ada Example",documentNumberLast4:"4567",model:"gemini-vision"});
});
test("synthetic Gemini OCR: accept Emirates ID with 784 prefix",()=>{
  assert.equal(parseGeminiVisionResult({
    documentType:"emirates_id",readable:true,fullName:"Ada Example",
    documentNumber:"784-2020-1234567-1",
  },"emirates_id").documentNumberLast4,"5671");
});
test("synthetic Gemini OCR: fail closed on swapped/missing/invalid identities",()=>{
  for(const x of [
    {documentType:"passport",readable:true,fullName:"Ada Example",documentNumber:"P1234567"},
    {documentType:"emirates_id",readable:false,fullName:"Ada Example",documentNumber:"784202012345671"},
    {documentType:"emirates_id",readable:true,fullName:"Ada",documentNumber:"784202012345671"},
    {documentType:"emirates_id",readable:true,fullName:"Ada Example",documentNumber:"78420201234567X"},
  ]) assert.throws(()=>parseGeminiVisionResult(x,"emirates_id"));
});
