#!/usr/bin/env node
/**
 * Isolated local Gotenberg smoke: no n8n workflow activation, secrets,
 * Salesforce, payment gateway, customer data, or externally reachable route.
 */
try {
  if (process.env.APP_ENV !== "development") {
    throw Error("Local-only PDF smoke requires APP_ENV=development");
  }
  const html = '<!doctype html><html><head><meta charset="utf-8"></head>' +
    '<body><h1>ANCFZ DEMO</h1><p>Synthetic quotation PDF smoke, NOT an invoice.</p></body></html>';
  const form = new FormData();
  form.append("files", new Blob([html],{type:"text/html"}), "index.html");
  const response = await fetch("http://gotenberg:3000/forms/chromium/convert/html", {
    method:"POST", body:form, signal:AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error("Gotenberg rejected synthetic PDF request (HTTP " + response.status + ")");
  const pdf = Buffer.from(await response.arrayBuffer());
  if (pdf.length<100 || pdf.length>5*1024*1024 || pdf.toString("ascii",0,5)!=="%PDF-" ||
    !pdf.subarray(Math.max(0,pdf.length-1024)).toString("ascii").includes("%%EOF")) {
    throw Error("Gotenberg response is not a bounded PDF");
  }
  process.stdout.write(JSON.stringify({ok:true,pdfBytes:pdf.length,pdfSignature:"%PDF-",type:"synthetic_quotation",paymentVerified:false})+"\n");
} catch(error) {
  process.stdout.write(JSON.stringify({ok:false,error:String(error?.message||"PDF smoke failed").slice(0,160)})+"\n");
  process.exitCode=1;
}
