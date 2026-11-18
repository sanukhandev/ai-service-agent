/** Presentation only. Node validates the exact displayed, immutable proposal.
 * Never treat a UI button or previous conversation turn as authorization.
 */
import type { ChatMessage } from "./chat-api";

export const QUOTATION_CONSENT_TEXT =
  "I authorize ANCFZ to send my contact details to Salesforce and prepare the non-binding quotation shown.";
export const PURCHASE_CONSENT_TEXT =
  "I authorize the ANCFZ sandbox purchase and test payment for the exact quotation amount shown.";

export type PendingChatConsent = {
  messageId:string;
  kind:"quotation"|"purchase";
  text:string;
  mode:"consent"|"review";
};

const REFERENCE=/\bProposal reference:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function proposalText(message:Pick<ChatMessage,"role"|"text">):
  Pick<PendingChatConsent,"kind"|"text">|null{
  if(message.role!=="assistant"||!REFERENCE.test(message.text))return null;
  // Whitespace/Markdown variations must not hide the exact Node consent CTA.
  const visible=message.text.replace(/[\*\r\n]+/g," ").replace(/\s+/g," ");
  if(visible.includes("Review your ANCFZ enquiry and quotation") &&
     visible.includes(QUOTATION_CONSENT_TEXT))
    return {kind:"quotation",text:QUOTATION_CONSENT_TEXT};
  if(visible.includes("Review your sandbox purchase and test payment") &&
     visible.includes(PURCHASE_CONSENT_TEXT))
    return {kind:"purchase",text:PURCHASE_CONSENT_TEXT};
  return null;
}
function approvedCustomerReply(text:string):boolean{
  const normalized=text.trim().replace(/[.!]+$/g,"").toLowerCase();
  return normalized===QUOTATION_CONSENT_TEXT.toLowerCase().replace(/\.$/,"") ||
    normalized===PURCHASE_CONSENT_TEXT.toLowerCase().replace(/\.$/,"") ||
    /^(?:yes|yes please|yes, please|go ahead|i approve|i consent|approved|please proceed|proceed)$/i.test(normalized);
}

/** If the customer interrupted the proposal, Node requires a FRESH review;
 * render "Review proposal again", never an invalid approval button. */
export function pendingChatConsent(
  messages:readonly Pick<ChatMessage,"id"|"role"|"text">[],
):PendingChatConsent|null{
  let pending:PendingChatConsent|null=null;
  for(const message of messages){
    if(message.role==="customer"){
      if(!pending)continue;
      if(approvedCustomerReply(message.text))pending=null;
      else {
        const proposal=pending as PendingChatConsent;
        pending={...proposal,mode:"review",
        text:proposal.kind==="quotation"
          ?"Please show the current ANCFZ enquiry and quotation proposal again for review."
          :"Please show the current sandbox purchase and test payment proposal again for review."};
      }
      continue;
    }
    const action=proposalText(message);
    if(action)pending={messageId:message.id,...action,mode:"consent"};
  }
  return pending;
}
