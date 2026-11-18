/**
 * Conservative, source-linked recovery when GPT omits a fact-write tool call.
 * This is NOT a scripted dialogue engine: it only interprets the answer to
 * the immediately preceding customer-visible question, or an explicit
 * compound package statement. The repository still checks ticket ownership,
 * allowed catalog keys and actual customer-message provenance.
 */
import {extractCompoundPackageFacts, type CustomerFactValue} from "./fact-validation.js";

export type SourcedFactCandidate={key:string;value:CustomerFactValue};
export function recoverSourcedAnswer(input:{
  previousAssistant:string|null;
  customerText:string;
  requestedAction:string|null;
  activeIntent:string|null;
  knownFacts:Record<string,unknown>;
  missingRequirements:readonly string[];
}):SourcedFactCandidate[]{
  const {previousAssistant,customerText,requestedAction,activeIntent,knownFacts}=input;
  if(!activeIntent||!requestedAction||
      !["create_lead","generate_quote"].includes(requestedAction))return [];
  const raw=customerText.trim();
  if(!raw||raw.length>200||/[\r\n<>]/.test(raw)||raw.includes("?")||
     /^(?:yes|no|ok|okay|sure|thanks|thank you|not sure|i don't know|skip|cancel|stop|confirm|proceed)$/i.test(raw))
    return [];
  const out:SourcedFactCandidate[]=[];
  for(const item of extractCompoundPackageFacts(raw))
    if(input.missingRequirements.includes(item.key)||
       knownFacts[item.key]!==item.value)out.push(item);
  // No interpolation of names, email addresses, country or industry from
  // unrelated chat. Only an immediate, explicit answer to the preceding
  // question can be reconciled without another model tool call.
  const question=previousAssistant??"";
  if(/\b(?:phone|mobile|contact number)\b/i.test(question) &&
     knownFacts["customer_phone"]===undefined &&
     /^[+0-9\s().-]{3,40}$/.test(raw))
    out.push({key:"customer_phone",value:raw});
  if(/\b(?:business activity|what (?:work|services|products)|company (?:do|provide|sell)|business (?:do|provide|sell))\b/i.test(question) &&
     input.missingRequirements.includes("business_activity") &&
     /^\p{L}[\p{L}\d &(),.+/'-]{2,160}$/u.test(raw) &&
     !/\b(?:quote|quotation|invoice|payment|consent|approve|otp|salesforce)\b/i.test(raw))
    out.push({key:"business_activity",value:raw});
  if(/\b(?:email|e-mail)\b/i.test(question) &&
     knownFacts["customer_email"]===undefined &&
     /@/.test(raw) && !/\s/.test(raw))
    out.push({key:"customer_email",value:raw});
  return [...new Map(out.map(candidate=>[candidate.key,candidate])).values()];
}
