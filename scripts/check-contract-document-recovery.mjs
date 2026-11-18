#!/usr/bin/env node
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {validateContractDocuments} from "../services/api/dist/runtime/service-contract-worker.js";

const data=Buffer.alloc(150,0x20);
Buffer.from([137,80,78,71,13,10,26,10]).copy(data,0);
const sha=createHash("sha256").update(data).digest("hex");
const base={name:"test.png",contentType:"image/png",bytes:data,sha256:sha};
const passport={...base,kind:"passport",extractedName:null,last4:null,
  extractionStatus:"pending",extractionModel:"prebuilt-idDocument"};
const emirates={...base,kind:"emirates_id",extractedName:"Demo Customer",
  last4:"1234",extractionStatus:"extracted",extractionModel:"prebuilt-idDocument"};

// Precisely the already consented POC passport allowance; never global.
assert.doesNotThrow(()=>validateContractDocuments([passport,emirates],true));
assert.throws(()=>validateContractDocuments([passport,emirates],false),
  /private_document_evidence_mismatch/);
assert.throws(()=>validateContractDocuments([
  {...passport,extractionModel:"unknown"},emirates],true),
  /private_document_evidence_mismatch/);
assert.throws(()=>validateContractDocuments([
  {...passport,extractionStatus:"extracted"},emirates],true),
  /private_document_evidence_mismatch/);
assert.throws(()=>validateContractDocuments([passport,{
  ...emirates,extractedName:null}],true),/private_document_evidence_mismatch/);
assert.throws(()=>validateContractDocuments([passport,{
  ...emirates,last4:"XXXX"}],true),/verified_emirates_last4_missing/);
assert.throws(()=>validateContractDocuments([
  {...passport,sha256:"0".repeat(64)},emirates],true),/private_document_evidence_mismatch/);
assert.throws(()=>validateContractDocuments([
  {...passport,extractedName:"Other Person",extractionStatus:"extracted"},emirates],true),
  /identity_names_do_not_match/);
assert.doesNotThrow(()=>validateContractDocuments([
  {...passport,extractedName:"Demo Customer",extractionStatus:"extracted"},emirates],false));
assert.throws(()=>validateContractDocuments([emirates],true),/required_private_documents_missing/);
const worker=readFileSync("services/api/src/runtime/service-contract-worker.ts","utf8");
assert.match(worker,/allowUnnamedSyntheticPassport\(\)/);
assert.match(worker,/d\.extraction_status='pending'/);
assert.match(worker,/d\.extraction_model='prebuilt-idDocument'/);
assert.match(worker,/d\.extracted_full_name IS NULL/);
assert.match(worker,/pc\.consent_text=\$5/);
assert.match(worker,/failure_code='legacy_retry_queued'/);
assert.match(worker,/c\.failure_code IS NULL/);
assert.match(worker,/i\.state='verified_completed'/);
assert.match(worker,/p\.state='verified_test_payment'/);
assert.match(worker,/c\.bytes IS NULL/);
console.log("Contract evidence PASS: approved synthetic passport, full Emirates ID checks, one-shot paid agreement recovery and no duplicate payment");
