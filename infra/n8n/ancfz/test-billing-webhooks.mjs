#!/usr/bin/env node
/**
 * Private n8n-only ANCFZ billing acceptance smoke. No provider payment/order
 * creation. Receives an ephemeral webhook secret via stdin (never argv/logs).
 * Never returns the secret, PDF contents, or customer data.
 */
let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString("utf8");
  if (input.length > 8192) throw Error("Invalid billing smoke request length");
}
try {
  if (process.env.APP_ENV !== "development") {
    throw Error("Synthetic billing smoke requires APP_ENV=development");
  }
  const req = JSON.parse(input);
  if (req?.action !== "quotation") throw Error("2Checkout verification requires a real provider order; synthetic status checks disabled");
  if (!["quotation", "verification"].includes(req.action) ||
      typeof req.secret !== "string" || req.secret.length < 32) {
    throw Error("Invalid synthetic billing smoke input");
  }
  const ticketId = "11111111-1111-4111-8111-111111111111";
  const quotationId = "22222222-2222-4222-8222-222222222222";
  let path, payload;
  if (req.action === "quotation") {
    path = "ancfz/render-pdf";
    payload = {
      agentKey:"ancfz",ticketId,documentType:"quotation",
      documentNumber:"ANCFZ-TEST-Q-"+quotationId,
      customerName:"Synthetic POC Customer",
      currency:"AED",lines:[{label:"Synthetic Test Package",amount:12.34}],
      total:12.34,
    };
  } else {
    path = "ancfz/payment-verify";
    payload = {
      agentKey:"ancfz",ticketId,orderReference:"synthetic_order_123",
      externalReference:"ANCFZ-synthetic-12345678",currency:"AED",amount:"12.34",
    };
  }
  const response = await fetch("http://127.0.0.1:5678/webhook/" + path,{
    method:"POST",
    redirect:"error",
    headers:{"X-ANCFZ-Workflow-Key":req.secret,"Content-Type":"application/json"},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error("n8n private "+req.action+" webhook failed (HTTP "+response.status+")");
  const text=await response.text();
  if (text.length>7_200_000) throw Error("Oversized n8n workflow response");
  const body=JSON.parse(text);
  if (req.action === "quotation") {
    if(body.status!=="generated"||body.documentType!=="quotation"||
       body.ticketId!==ticketId||body.documentNumber!==payload.documentNumber||
       body.mimeType!=="application/pdf"||typeof body.pdfBase64!=="string"||
       body.pdfBase64.length>7_000_000)throw Error("Unexpected quotation PDF payload");
    const data=Buffer.from(body.pdfBase64,"base64");
    if(data.length<100||data.length>5_242_880||
       data.toString("ascii",0,5)!=="%PDF-"||
       !data.subarray(Math.max(0,data.length-1024)).toString("ascii").includes("%%EOF"))
      throw Error("Quotation binary validation failed");
    process.stdout.write(JSON.stringify({
      ok:true,action:req.action,status:"generated",pdfBytes:data.length,
      paymentVerified:false,documentNumber:payload.documentNumber,
    })+"\n");
  } else {
    if(body.verified!==false||body.status!=="verification_unconfigured"||
       body.ticketId!==ticketId||body.orderReference!==payload.orderReference)
      throw Error("Payment verifier did not fail closed; stop testing");
    process.stdout.write(JSON.stringify({
      ok:true,action:req.action,status:"verification_unconfigured",verified:false,
    })+"\n");
  }
} catch(error) {
  process.stdout.write(JSON.stringify({
    ok:false,error:String(error?.message||"Billing smoke failed").slice(0,180),
  })+"\n");
  process.exitCode=1;
}
