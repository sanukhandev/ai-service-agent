import type { ChatMessage, SourceReference } from "../lib/chat-api";
import type { ReactNode } from "react";

function formattedText(text: string): ReactNode[] {
  const pieces = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g);
  return pieces.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index} className="font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index} className="rounded bg-slate-200/60 px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>;
    return part;
  });
}

/** Citation URLs are untrusted. Avoid script schemes, credentials and signed-secret URLs. */
function safeCitationUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) return null;
    if (url.hostname.endsWith(".internal") || url.hostname.endsWith(".local")) return null;
    for (const key of url.searchParams.keys()) {
      if (/^(sig|signature|se|sp|sv|token|access_token|key|api_key|secret|code)$/i.test(key)) return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function Citation({ reference }: { reference: SourceReference }) {
  const uri = safeCitationUrl(reference.uri);
  const label = reference.title?.trim() || reference.sourceId;
  return (
    <li className="max-w-full">
      {uri ? (
        <a href={uri} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:border-blue-300 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">
          <span aria-hidden="true">↗</span><span className="truncate">{label}</span>
        </a>
      ) : (
        <span className="inline-flex max-w-full items-center rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600" title={reference.sourceId}>{label}</span>
      )}
    </li>
  );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const assistant = message.role === "assistant";
  const references = assistant ? message.sourceReferences?.filter((ref) => ref.sourceId.trim()) ?? [] : [];
  const time = new Date(message.createdAt);
  const validDate = !Number.isNaN(time.getTime());
  return (
    <li className={`flex min-w-0 gap-3 ${assistant ? "justify-start" : "justify-end"}`}>
      {assistant && <span aria-hidden="true" className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-700 text-xs font-semibold text-white">S</span>}
      <article className={`min-w-0 max-w-[min(85%,38rem)] ${assistant ? "text-left" : "text-right"}`} aria-label={assistant ? "Sara" : "You"}>
        <p className={`mb-1 text-xs font-medium text-slate-500 ${assistant ? "" : "text-right"}`}>{assistant ? "Sara" : "You"}</p>
        <div className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-[0.9375rem] leading-7 ${assistant ? "rounded-tl-sm border border-slate-200 bg-white text-slate-800 shadow-sm" : "rounded-tr-sm bg-blue-700 text-white"}`}>
          {formattedText(message.text)}
        </div>
        {references.length > 0 && (
          <div className="mt-2 text-left">
            <p className="mb-1.5 text-[0.7rem] font-medium text-slate-500">Sources</p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Response sources">{references.map((ref, i) => <Citation reference={ref} key={`${ref.sourceId}-${i}`} />)}</ul>
          </div>
        )}
        {validDate && <time dateTime={message.createdAt} className="mt-1.5 block text-[0.7rem] text-slate-400">{time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>}
      </article>
    </li>
  );
}
