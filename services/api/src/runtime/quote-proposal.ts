/** Immutable, source-linked customer requirements and published package scope
 * for non-binding ANCFZ test quotations. Never infer billable inclusions from
 * customer preferences or Foundry prose. All values come from ticket facts and
 * the ticket-pinned offering catalog.
 */
import type {PoolClient} from "pg";

export type QuoteRequirement={label:string;value:string};
export type QuoteProposalDetails={
  packageDescription:string;
  requirements:QuoteRequirement[];
  priceConditions:string|null;
};

type RequirementRow={
  requirement_key:string;label:string;value:unknown;
  verification_status:string|null;
};
const labels:Record<string,string>={
  business_activity:"Business activity",
  preferred_company_name:"Preferred company name",
  company_name:"Company name",
  shareholder_count:"Number of shareholders",
  shareholder_nationality:"Shareholder nationality",
  visa_count:"Requested residence visas",
  term_years:"Licence term (years)",
  office_preference:"Preferred workspace",
  customer_email:"Enquiry contact email",
};
const order=[
  "business_activity","preferred_company_name","company_name",
  "shareholder_count","shareholder_nationality","visa_count",
  "term_years","office_preference","customer_email",
];
const personalOrPrivate=/^(?:passport|emirates_id|identity|document_number|otp|card|payment_)/i;
const short=(input:string,max=400):string=>
  input.replace(/[\u0000-\u001f\u007f]+/g," ").replace(/\s+/g," ").trim().slice(0,max);

export function quoteRequirements(rows:readonly RequirementRow[]):QuoteRequirement[]{
  const unique=new Map<string,QuoteRequirement>();
  for(const row of rows){
    if(row.verification_status==="disputed" ||
       row.value===null||row.value===undefined||
       personalOrPrivate.test(row.requirement_key))continue;
    if(typeof row.value!=="string"&&typeof row.value!=="number"&&
       typeof row.value!=="boolean")continue;
    const value=short(String(row.value));
    if(!value||unique.has(row.requirement_key))continue;
    unique.set(row.requirement_key,{
      label:short(labels[row.requirement_key]??row.label,140),
      value,
    });
  }
  return [...rows]
    .filter(row=>unique.has(row.requirement_key))
    .sort((a,b)=>{
      const rank=(k:string)=>order.includes(k)?order.indexOf(k):order.length;
      return rank(a.requirement_key)-rank(b.requirement_key)||
        a.requirement_key.localeCompare(b.requirement_key);
    })
    .map(row=>unique.get(row.requirement_key)!)
    .filter((v,i,arr)=>arr.findIndex(x=>x===v)===i).slice(0,25);
}

/** No untrusted scope/IDs are accepted: caller passes the already scoped
 * connection, verified ticket and agent IDs. */
export async function quoteRequirementsTx(
  client:PoolClient,agentId:string,ticketId:string,
):Promise<QuoteRequirement[]>{
  const r=await client.query<RequirementRow&{intent_key:string}>(
    `SELECT req.requirement_key,req.label,tf.value,tf.verification_status,i.intent_key
     FROM tickets t
     JOIN ticket_intents ti ON ti.agent_id=t.agent_id
       AND ti.ticket_id=t.id AND ti.status='active'
     JOIN intents i ON i.agent_id=ti.agent_id AND i.id=ti.intent_id
       AND i.catalog_version_id=t.intent_catalog_version_id
     JOIN intent_requirements req ON req.agent_id=i.agent_id
       AND req.intent_id=i.id
     LEFT JOIN ticket_facts tf ON tf.agent_id=t.agent_id
       AND tf.ticket_id=t.id AND tf.fact_key=req.requirement_key
     WHERE t.agent_id=$1 AND t.id=$2
       AND req.required_for && ARRAY['create_lead','generate_quote']::text[]
     ORDER BY req.requirement_key`,
    [agentId,ticketId],
  );
  const requirements=quoteRequirements(r.rows);
  if(r.rows.some(x=>x.intent_key==="license_renewal")){
    const renewal=await client.query<{
      licence_number:string;company_name:string;expires_on:string;
      renewal_term_years:number;
    }>(`SELECT licence_number,company_name,expires_on::text,renewal_term_years
       FROM ticket_licence_renewals WHERE agent_id=$1 AND ticket_id=$2
       AND state='confirmed'`,[agentId,ticketId]);
    const row=renewal.rows[0];
    if(!row)throw new Error("Confirmed licence renewal lookup required before quotation");
    // The Data Table snapshot is more authoritative than free-form chat facts.
    const exclude=new Set(["Existing licence reference","Renewal duration"]);
    return [...requirements.filter(x=>!exclude.has(x.label)),
      {label:"Licence number",value:short(row.licence_number)},
      {label:"Licensed company",value:short(row.company_name)},
      {label:"Current licence expiry",value:short(row.expires_on)},
      {label:"Renewal duration (years)",value:String(row.renewal_term_years)}];
  }
  return requirements;
}
export function quoteDetails(
  description:string,requirements:QuoteRequirement[],
  conditions:string|null,
):QuoteProposalDetails{
  return {
    packageDescription:short(description,3000),
    requirements:requirements.map(x=>({
      label:short(x.label,140),value:short(x.value,400),
    })).slice(0,25),
    priceConditions:conditions?short(conditions,3000):null,
  };
}
export const QUOTATION_SCOPE_NOTICE=
  "This is a non-binding test quotation for the published package only. "+
  "The preferred workspace is a customer request, not a priced inclusion "+
  "unless the published package description or conditions explicitly say so. "+
  "Licensing, visa issuance and activity approval remain subject to ANCFZ and applicable authorities.";

export function quoteDetailsMarkdown(details:QuoteProposalDetails):string{
  const requirements=details.requirements.length
    ?details.requirements.map(x=>"- "+x.label+": "+x.value).join("\n")
    :"No itemized customer requirements were recorded for this quotation.";
  return [
    "**Published package scope**",
    details.packageDescription||"No published package description available.",
    "**Customer requirements used for this quotation**",
    requirements,
    "**Published price conditions**",
    details.priceConditions||"No additional price conditions published in this revision.",
    "**Important limits**",
    QUOTATION_SCOPE_NOTICE,
  ].join("\n\n");
}
