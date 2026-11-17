/** Immutable quotation scope is the invoice's only source of descriptive
 * package facts. Do not re-read mutable customer facts or a newer catalog. */
import type { QuoteProposalDetails } from "./quote-proposal.js";

export function invoiceQuoteDetails(
  raw:unknown,
  expected:{quotationDocumentNumber:string;amount:string;currency:string},
):QuoteProposalDetails|null{
  if(!raw || typeof raw!=="object" || Array.isArray(raw)) return null;
  const value=raw as Record<string,unknown>;
  // Never attach a different quote's scope or pricing to a paid invoice.
  if(value.documentType!=="quotation" ||
     value.documentNumber!==expected.quotationDocumentNumber ||
     value.currency!==expected.currency ||
     typeof value.total!=="number" ||
     !Number.isFinite(value.total) ||
     value.total.toFixed(2)!==Number(expected.amount).toFixed(2))
    throw new Error("Invoice source quotation correlation failed");
  const p=value.proposal;
  if(p===undefined||p===null)return null; // Legacy quote without a scope snapshot.
  if(typeof p!=="object"||Array.isArray(p))throw new Error("Invalid quotation scope");
  const x=p as Record<string,unknown>;
  if(typeof x.packageDescription!=="string"||x.packageDescription.length>3000 ||
     (x.priceConditions!==null&&typeof x.priceConditions!=="string") ||
     (typeof x.priceConditions==="string"&&x.priceConditions.length>3000) ||
     !Array.isArray(x.requirements)||x.requirements.length>25)
    throw new Error("Invalid quotation scope");
  const requirements=x.requirements.map((r:unknown)=>{
    if(!r||typeof r!=="object"||Array.isArray(r))throw new Error("Invalid requirement");
    const item=r as Record<string,unknown>;
    if(typeof item.label!=="string"||typeof item.value!=="string"||
       !item.label.trim()||!item.value.trim()||
       item.label.length>140||item.value.length>400)
      throw new Error("Invalid requirement");
    return {label:item.label,value:item.value};
  });
  return {packageDescription:x.packageDescription,
    priceConditions:x.priceConditions as string|null,requirements};
}
