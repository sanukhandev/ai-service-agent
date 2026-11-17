/** Conservative repair for a directly answered, Node-authored missing-fact
 * question. This does not classify activities, select an intent, approve
 * business actions, or trust anything except the current customer message. */
export function sourcedBusinessActivityReply(input: {
  previousAssistant: string | null;
  customerText: string;
  requestedAction: string | null;
  missingBusinessActivity: boolean;
}): string | null {
  if (!input.missingBusinessActivity ||
      (input.requestedAction !== "generate_quote" &&
       input.requestedAction !== "create_lead")) return null;
  // Only an immediate answer to the exact Node-authored question is eligible.
  // Do not extract activities from unrelated general chat, older turns or IQ.
  const question = input.previousAssistant?.trim();
  if (question !== "What business activity will your company perform?" &&
      question !== "What business activity will your company carry out?") return null;
  const raw = input.customerText;
  if (raw.includes("\n") || raw.includes("\r")) return null;
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length < 4 || text.length > 160 || /[?<>]/.test(text) ||
      !/\p{L}{3,}/u.test(text)) return null;
  // Declines, vague acknowledgements, contact details and other requests
  // are not customer-stated business activities.
  if (/^(?:yes|no|ok|okay|sure|thanks|thank you|not sure|i don't know|don't know|maybe|none|skip|services?|company|business|ai|it|ai company|it company)$/i.test(text) ||
      /\b(?:quote|quotation|invoice|payment|checkout|consent|approve|passport|emirates id|otp|salesforce|cancel|stop)\b/i.test(text) ||
      /\S+@\S+|https?:\/\/|\b\+?\d[\d ()-]{6,}\b/i.test(text)) return null;
  return text;
}
