#!/usr/bin/env node
/** Offline upload metadata regression: test files only, no identity data or OCR. */
import assert from "node:assert/strict";
import { preparePurchaseDocumentUpload } from "../services/api/dist/runtime/purchase-operations.js";

const pdf=Buffer.concat([Buffer.from("%PDF-1.7\n"),Buffer.alloc(150)]);
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(150)]);
const jpeg=Buffer.concat([Buffer.from([255,216,255,224]),Buffer.alloc(150)]);
const payload=(bytes,extra={})=>({
  requirementKey:"passport",
  fileName:"Passport (1).pdf",
  contentType:"application/octet-stream",
  dataBase64:bytes.toString("base64"),
  ...extra,
});

const named=preparePurchaseDocumentUpload(payload(pdf));
assert.equal(named.fileName,"Passport (1).pdf");
assert.equal(named.contentType,"application/pdf");
assert.deepEqual(named.bytes,pdf);

// The filename may contain punctuation, Unicode or a long browser-generated
// name. It is stored safely without unnecessarily rejecting the upload.
const international=preparePurchaseDocumentUpload(payload(pdf,{
  fileName:"Jöhn — Passport (2).pdf",
  contentType:"",
  clientMetadata:"ignored",
}));
assert.equal(international.fileName,"Jöhn — Passport (2).pdf");
assert.equal(international.contentType,"application/pdf");

const noName=preparePurchaseDocumentUpload(payload(png,{
  requirementKey:"emirates_id",fileName:"",
}));
assert.equal(noName.fileName,"emirates_id.png");
assert.equal(noName.contentType,"image/png");

const sanitized=preparePurchaseDocumentUpload(payload(pdf,{
  fileName:"..\\..\\test/Passport (1).pdf",
}));
assert.equal(sanitized.fileName,".._.._test_Passport (1).pdf");
assert.equal(Array.from(preparePurchaseDocumentUpload(payload(pdf,{
  fileName:"😀".repeat(160)+"-passport.pdf",
})).fileName).length,150);

const jpg=preparePurchaseDocumentUpload(payload(jpeg,{
  fileName:"ID Front (1).jpeg",
  contentType:"application/pdf", // Untrusted claim; signature wins.
}));
assert.equal(jpg.contentType,"image/jpeg");

// Browser metadata is optional, but file identity/size and requirement safety
// are not. Do not let bypassing metadata introduce arbitrary file uploads.
assert.throws(()=>preparePurchaseDocumentUpload(payload(Buffer.alloc(150))),/Only PDF, PNG or JPEG/);
assert.throws(()=>preparePurchaseDocumentUpload(payload(Buffer.concat([
  Buffer.from("%PDF-1.7\n"),Buffer.alloc(1048576),
]))),/oversized/i);
assert.throws(()=>preparePurchaseDocumentUpload(payload(pdf,{
  requirementKey:"driver_license",
})),/Unsupported document requirement/);
assert.throws(()=>preparePurchaseDocumentUpload(payload(pdf,{
  dataBase64:"not-base64",
})),/Invalid or oversized document data/);

console.log("Document upload metadata PASS: common filenames, canonical MIME, safe sanitization and strict file gates");
