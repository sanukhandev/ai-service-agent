/** Presentation-only detection of an outstanding Node-authored chat proposal.
 * The button sends an ordinary customer message; the existing Node consent
 * validator remains the sole authority for whether the proposal is valid. */
import type { ChatMessage } from "./chat-api";

export const QUOTATION_CONSENT_TEXT =
  "I authorize ANCFZ to send my contact details to Salesforce and prepare the non-binding quotation shown.";
export const PURCHASE_CONSENT_TEXT =
  "I authorize the ANCFZ sandbox purchase and test payment for the exact quotation amount shown.";

export type PendingChatConsent = {
  messageId: string;
  kind: "quotation" | "purchase";
  text: string;
};

const PROPOSAL_REFERENCE =
  /^Proposal reference: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/im;

function proposalText(message: Pick<ChatMessage, "role" | "text">):
  Pick<PendingChatConsent, "kind" | "text"> | null {
  if (message.role !== "assistant" || !PROPOSAL_REFERENCE.test(message.text))
    return null;
  if (message.text.includes("**Review your ANCFZ enquiry and quotation**") &&
      message.text.includes('To approve both actions, reply: "' + QUOTATION_CONSENT_TEXT + '"')) {
    return {kind: "quotation", text: QUOTATION_CONSENT_TEXT};
  }
  if (message.text.includes("**Review your sandbox purchase and test payment**") &&
      message.text.includes('To approve, reply: "' + PURCHASE_CONSENT_TEXT + '"')) {
    return {kind: "purchase", text: PURCHASE_CONSENT_TEXT};
  }
  return null;
}

/** A customer reply after a proposal invalidates the button. Unrelated
 * assistant lifecycle notices do not, because the exact consent text remains
 * eligible for Node's independently validated interrupted-notice case. */
export function pendingChatConsent(
  messages: readonly Pick<ChatMessage, "id" | "role" | "text">[],
): PendingChatConsent | null {
  let pending: PendingChatConsent | null = null;
  for (const message of messages) {
    if (message.role === "customer") {
      pending = null;
      continue;
    }
    const action = proposalText(message);
    if (action) pending = {messageId: message.id, ...action};
  }
  return pending;
}
