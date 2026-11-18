/**
 * Validation at the model/Node fact boundary. Browser text and model-extracted
 * candidates are untrusted. This is NOT a telephone ownership/reachability
 * verification or a substitute for final provider preflight.
 */
export type CustomerFactValue=string|number|boolean;
export type FactDecision=
  | {status:"accepted";key:string;value:CustomerFactValue}
  | {status:"needs_clarification"|"rejected";key:string;reasonCode:string;clarificationHint:string};
export type FactType="text"|"number"|"email"|"choice";

const result=(key:string,status:"needs_clarification"|"rejected",
  reasonCode:string,clarificationHint:string):FactDecision=>
  ({key,status,reasonCode,clarificationHint});
const numeric=(value:CustomerFactValue):number|null=>{
  if(typeof value==="number")return Number.isSafeInteger(value)?value:null;
  if(typeof value==="string"&&/^\d{1,5}$/.test(value.trim()))
    return Number(value.trim());
  return null;
};

/** Explicit international numbers only; never infer a country from nationality. */
export function normalizeContactPhone(value:CustomerFactValue):FactDecision {
  const key="customer_phone";
  if(typeof value!=="string")return result(key,"rejected","PHONE_INVALID",
    "Please share a phone number as text, including its international country code.");
  const raw=value.trim();
  if(!raw||/[A-Za-z@]/.test(raw)||!/^[+0-9\s().-]+$/.test(raw))
    return result(key,"rejected","PHONE_INVALID",
      "That does not look like a phone number. Include the country code, for example +971.");
  let compact=raw.replace(/[\s().-]/g,"");
  if(compact.startsWith("00"))compact="+"+compact.slice(2);
  if(!compact.startsWith("+"))
    return result(key,"needs_clarification","PHONE_COUNTRY_REQUIRED",
      "Please confirm the country or send the full number with country code, such as +971 for UAE. Do not infer the country from nationality.");
  if(!/^\+[1-9]\d{7,14}$/.test(compact))
    return result(key,"rejected","PHONE_LENGTH_OR_PREFIX",
      "The international number seems incomplete or has an invalid country-code/length format. Check the digits after the +.");
  // UAE numbers have nine national digits; tolerate mobiles and landlines,
  // but don't claim this proves the number can receive messages.
  if(compact.startsWith("+971")&&!/^\+971[2-9]\d{8}$/.test(compact))
    return result(key,"rejected","PHONE_UAE_FORMAT",
      "A UAE number should have nine digits after +971 (for example +971585751302).");
  return {key,status:"accepted",value:compact};
}

export function validateConversationFact(
  key:string,value:CustomerFactValue,expectedType:FactType,
):FactDecision {
  if(key==="customer_phone")return normalizeContactPhone(value);
  if(key==="visa_count"||key==="term_years"||key==="shareholder_count"||
     expectedType==="number"){
    const number=numeric(value);
    const min=key==="visa_count"?0:1;
    const max=key==="visa_count"?10:key==="term_years"?5:10000;
    if(number===null||number<min||number>max)
      return result(key,"needs_clarification","NUMBER_OUT_OF_RANGE",
        key==="visa_count"?"How many visas do you need, from 0 to 10?":
        key==="term_years"?"Would you prefer a licence term of 1 to 5 years?":
        "Please give a positive whole-number quantity.");
    return {key,status:"accepted",value:number};
  }
  if(typeof value!=="string"){
    return result(key,"rejected","TEXT_REQUIRED",
      "Please provide this detail as text.");
  }
  const text=value.trim().replace(/\s+/g," ");
  if(!text||text.length>1000)
    return result(key,"rejected","TEXT_LENGTH",
      "Please provide a non-empty response of reasonable length.");
  if(key==="customer_email"||key==="email"||key==="customer_test_email"||
     expectedType==="email"){
    const email=text.toLowerCase();
    const pattern=/^[^\s@\\<>()]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if(!pattern.test(email)||email.includes(".."))
      return result(key,"needs_clarification","EMAIL_INVALID",
        "The email address seems incomplete or contains an extra character. Could you check it?");
    if(key==="customer_test_email"&&!/^[A-Za-z0-9._%+-]+@example\.invalid$/.test(email))
      return result(key,"rejected","TEST_EMAIL_REQUIRED",
        "For this sandbox flow please use an address ending @example.invalid.");
    return {key,status:"accepted",value:email};
  }
  if(key==="customer_name"){
    if(!/^[\p{L}][\p{L} .'-]{1,119}$/u.test(text))
      return result(key,"needs_clarification","CUSTOMER_NAME_INVALID",
        "Please share your name using letters; Salesforce will also need a surname.");
    return {key,status:"accepted",value:text};
  }
  if(key==="business_activity"){
    if(/^(?:(?:ai|it)\s+(?:company|compa+n+y|business)|(?:ai|it|business|company|firm|services?|consultancy))$/i.test(text) ||
       /^ai buildings?$/i.test(text))
      return result(key,"needs_clarification","BUSINESS_ACTIVITY_TOO_BROAD",
        "What will the company actually provide or sell? For example, software development, IT consultancy or an AI product.");
    return {key,status:"accepted",value:text};
  }
  if(key==="shareholder_nationality" && /^(?:indi|emirat|uae?)$/i.test(text))
    return result(key,"needs_clarification","NATIONALITY_AMBIGUOUS",
      "Could you confirm the shareholder's nationality (for example, Indian or Emirati)?");
  if(key==="office_preference"){
    const office=text.toLowerCase();
    const normalized=
      /^(?:flexi(?:[- ]?desk)?)$/i.test(office)?"flexi_desk":
      /^(?:private(?: office)?)$/i.test(office)?"private_office":
      /^(?:shared(?: office| workspace)?)$/i.test(office)?"shared_office":text;
    return {key,status:"accepted",value:normalized};
  }
  return {key,status:"accepted",value:text};
}

/** Only evidence from the current source message; don't infer a user goal. */
export function extractCompoundPackageFacts(text:string):Array<{key:string;value:number}> {
  if(text.includes("?")||/\b(?:for example|e\.g\.|suppose|what if|how much|price|cost)\b/i.test(text))
    return [];
  const out:Array<{key:string;value:number}>=[];
  const visa=/\b(\d{1,2})\s*visas?\b/i.exec(text);
  const years=/\b(\d)\s*years?\b/i.exec(text);
  if(visa)out.push({key:"visa_count",value:Number(visa[1])});
  if(years)out.push({key:"term_years",value:Number(years[1])});
  return out;
}
