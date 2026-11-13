"use client";

import { useState, type ReactNode } from "react";
import type { ChatMessage, SourceReference } from "../lib/chat-api";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  SparklesIcon,
} from "./icons";

function formatInline(text: string): ReactNode[] {
  // Split on bold (**text**), italic (*text*), and inline code (`code`)
  const pieces = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g);
  return pieces.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold text-zinc-950">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <em key={index} className="italic text-zinc-700">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded-md border border-zinc-200/80 bg-zinc-100/90 px-1.5 py-0.5 text-[0.85em] font-mono font-medium text-zinc-850"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}

function RichTextContent({ text, isAssistant }: { text: string; isAssistant: boolean }) {
  if (!isAssistant) {
    return <div className="whitespace-pre-wrap break-words">{text}</div>;
  }

  // Parse structured blocks: headers, lists, code blocks, paragraphs
  const rawParagraphs = text.split(/\n{2,}/);

  return (
    <div className="space-y-3 text-[0.9375rem] leading-relaxed text-zinc-800">
      {rawParagraphs.map((para, pIdx) => {
        const lines = para.split("\n").map((l) => l.trimEnd());

        // Check if block is a code block
        if (lines[0]?.startsWith("```") && lines[lines.length - 1]?.endsWith("```")) {
          const codeContent = lines
            .slice(1, lines[lines.length - 1] === "```" ? -1 : undefined)
            .join("\n");
          return (
            <pre
              key={pIdx}
              className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/95 p-3.5 font-mono text-xs leading-5 text-zinc-200 shadow-inner"
            >
              <code>{codeContent}</code>
            </pre>
          );
        }

        // Check if block is entirely a bullet list
        const isBulletList = lines.every((line) => line === "" || /^[-*•]\s+/.test(line));
        if (isBulletList && lines.some((l) => /^[-*•]\s+/.test(l))) {
          return (
            <ul key={pIdx} className="space-y-1.5 pl-1">
              {lines
                .filter((l) => l.trim().length > 0)
                .map((line, lIdx) => {
                  const content = line.replace(/^[-*•]\s+/, "");
                  return (
                    <li key={lIdx} className="flex items-start gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-2 size-1.5 shrink-0 rounded-full bg-zinc-700"
                      />
                      <span className="min-w-0 flex-1">{formatInline(content)}</span>
                    </li>
                  );
                })}
            </ul>
          );
        }

        // Check if block is a numbered list
        const isNumberedList = lines.every((line) => line === "" || /^\d+\.\s+/.test(line));
        if (isNumberedList && lines.some((l) => /^\d+\.\s+/.test(l))) {
          return (
            <ol key={pIdx} className="space-y-1.5 pl-1">
              {lines
                .filter((l) => l.trim().length > 0)
                .map((line, lIdx) => {
                  const match = line.match(/^(\d+)\.\s+(.*)$/);
                  const num = match ? match[1] : `${lIdx + 1}`;
                  const content = match ? match[2] : line;
                  return (
                    <li key={lIdx} className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 text-[0.7rem] font-semibold text-zinc-800">
                        {num}
                      </span>
                      <span className="min-w-0 flex-1">{formatInline(content)}</span>
                    </li>
                  );
                })}
            </ol>
          );
        }

        // Check if header
        if (lines.length === 1 && lines[0].startsWith("#")) {
          const headerLevel = lines[0].match(/^#+/)?.[0].length || 1;
          const headerText = lines[0].replace(/^#+\s*/, "");
          if (headerLevel <= 2) {
            return (
              <h3 key={pIdx} className="pt-1 text-base font-semibold tracking-tight text-zinc-950">
                {formatInline(headerText)}
              </h3>
            );
          }
          return (
            <h4 key={pIdx} className="pt-1 text-sm font-semibold tracking-tight text-zinc-950">
              {formatInline(headerText)}
            </h4>
          );
        }

        // Check for blockquote
        if (lines.every((line) => line.startsWith(">"))) {
          const quote = lines.map((l) => l.replace(/^>\s?/, "")).join(" ");
          return (
            <blockquote
              key={pIdx}
              className="border-l-2 border-zinc-700 bg-zinc-100/70 py-1.5 pl-3 pr-2 text-sm italic text-zinc-700 rounded-r-lg"
            >
              {formatInline(quote)}
            </blockquote>
          );
        }

        // Regular paragraph with potential soft linebreaks
        return (
          <p key={pIdx} className="break-words">
            {lines.map((line, lIdx) => (
              <span key={lIdx}>
                {formatInline(line)}
                {lIdx < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** Resolves download URL via same-origin file download service or trusted external URL. */
function safeCitationUrl(
  uri: string | null | undefined,
  ticketId?: string,
  sourceId?: string,
): string | null {
  if (uri) {
    if (uri.startsWith("/api/v1/")) return uri;
    try {
      const url = new URL(uri);
      if (url.protocol === "https:" && !url.username && !url.password) {
        if (
          !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(
            url.hostname,
          ) &&
          !url.hostname.endsWith(".internal") &&
          !url.hostname.endsWith(".local")
        ) {
          let hasRiskyParams = false;
          for (const key of url.searchParams.keys()) {
            if (/^(sig|signature|se|sp|sv|token|access_token|key|api_key|secret|code)$/i.test(key)) {
              hasRiskyParams = true;
              break;
            }
          }
          if (!hasRiskyParams) return url.href;
        }
      }
    } catch {
      // not a standard URL
    }
  }

  // Fallback to internal ticket download service if ticketId and sourceId are available
  if (ticketId && sourceId) {
    return `/api/v1/tickets/${encodeURIComponent(ticketId)}/sources/${encodeURIComponent(
      sourceId,
    )}/download`;
  }

  return null;
}

function Citation({
  reference,
  ticketId,
}: {
  reference: SourceReference;
  ticketId?: string;
}) {
  const url = safeCitationUrl(reference.uri, ticketId, reference.sourceId);
  const label = reference.title?.trim() || reference.sourceId;
  const isDownload = Boolean(url && url.startsWith("/api/v1/"));

  return (
    <li className="max-w-full">
      {url ? (
        <a
          href={url}
          target={isDownload ? undefined : "_blank"}
          rel={isDownload ? undefined : "noopener noreferrer nofollow"}
          download={isDownload ? reference.title || reference.sourceId : undefined}
          title={isDownload ? "Download verified reference document" : "View source"}
          className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/80 bg-white/70 backdrop-blur-sm px-2.5 py-1.5 text-xs font-medium text-zinc-700 shadow-2xs transition-all hover:border-zinc-300 hover:bg-white hover:text-zinc-950 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-800"
        >
          {isDownload ? (
            <DownloadIcon className="size-3.5 shrink-0 text-zinc-400 transition-colors group-hover:text-zinc-800" />
          ) : (
            <FileTextIcon className="size-3.5 shrink-0 text-zinc-400 transition-colors group-hover:text-zinc-800" />
          )}
          <span className="truncate">{label}</span>
          {isDownload ? (
            <span className="ml-1 rounded border border-zinc-200/80 bg-zinc-100/90 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase text-zinc-600 transition-colors group-hover:bg-zinc-900 group-hover:text-white">
              Download
            </span>
          ) : (
            <ExternalLinkIcon className="size-3 shrink-0 text-zinc-400 opacity-70 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 group-hover:text-zinc-900" />
          )}
        </a>
      ) : (
        <span
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/80 bg-white/60 backdrop-blur-sm px-2.5 py-1.5 text-xs text-zinc-600 shadow-2xs"
          title={reference.sourceId}
        >
          <FileTextIcon className="size-3.5 shrink-0 text-zinc-400" />
          <span className="truncate">{label}</span>
        </span>
      )}
    </li>
  );
}

export function MessageBubble({
  message,
  ticketId,
}: {
  message: ChatMessage;
  ticketId?: string;
}) {
  const assistant = message.role === "assistant";
  const [copied, setCopied] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const references = assistant
    ? message.sourceReferences?.filter((ref) => ref.sourceId.trim()) ?? []
    : [];
  const time = new Date(message.createdAt);
  const validDate = !Number.isNaN(time.getTime());

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard copy fallback if blocked
    }
  }

  return (
    <li
      className={`group flex min-w-0 items-start gap-3 animate-fade-in ${
        assistant ? "justify-start" : "justify-end"
      }`}
    >
      {assistant && (
        <div
          aria-hidden="true"
          className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-zinc-950 via-zinc-900 to-zinc-800 text-white shadow-xs ring-2 ring-white/80 border border-white/30 backdrop-blur-md"
        >
          <SparklesIcon className="size-4.5 text-zinc-200" />
        </div>
      )}

      <article
        className={`min-w-0 max-w-[min(88%,42rem)] ${assistant ? "text-left" : "text-right"}`}
        aria-label={assistant ? "Sara" : "You"}
      >
        <div
          className={`mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-500 ${
            assistant ? "" : "justify-end"
          }`}
        >
          <span>{assistant ? "Sara · ANCFZ Assistant" : "You"}</span>
          {validDate && (
            <time dateTime={message.createdAt} className="text-[0.7rem] text-zinc-400">
              {time.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </time>
          )}
        </div>

        {/* Message Card with Frosted Glass styling */}
        <div
          className={`relative break-words rounded-2xl text-[0.9375rem] leading-relaxed transition-all ${
            assistant
              ? "rounded-tl-xs border border-white/80 bg-white/75 backdrop-blur-md p-4 text-zinc-850 shadow-[0_2px_16px_rgba(0,0,0,0.03)] ring-1 ring-zinc-900/5 hover:bg-white/85"
              : "rounded-tr-xs border border-zinc-800/80 bg-zinc-900/95 backdrop-blur-md px-4 py-3 text-white shadow-[0_4px_16px_rgba(24,24,27,0.15)] ring-1 ring-white/10"
          }`}
        >
          <RichTextContent text={message.text} isAssistant={assistant} />

          {/* Action footer for assistant responses */}
          {assistant && (
            <div className="mt-3 flex items-center justify-between border-t border-zinc-200/50 pt-2 text-[0.72rem] text-zinc-400">
              <span className="text-zinc-400">Official ANCFZ Service Knowledge</span>
              <button
                type="button"
                onClick={copyContent}
                aria-label={copied ? "Copied to clipboard" : "Copy response"}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-2 focus-visible:outline-zinc-800"
              >
                {copied ? (
                  <>
                    <CheckIcon className="size-3.5 text-emerald-600" />
                    <span className="text-emerald-700">Copied</span>
                  </>
                ) : (
                  <>
                    <CopyIcon className="size-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Minimized / Expandable Sources Section */}
        {references.length > 0 && (
          <div className="mt-2 text-left">
            <button
              type="button"
              onClick={() => setShowSources(!showSources)}
              aria-expanded={showSources}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-white/80 bg-white/60 px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-2xs backdrop-blur-md transition-all hover:border-zinc-300 hover:bg-white/95 hover:text-zinc-900 active:scale-95"
            >
              <FileTextIcon className="size-3.5 text-zinc-400 transition-colors group-hover:text-zinc-700" />
              <span>Sources ({references.length})</span>
              <ChevronDownIcon
                className={`size-3 text-zinc-400 transition-transform duration-200 group-hover:text-zinc-700 ${
                  showSources ? "rotate-180" : ""
                }`}
              />
            </button>

            {showSources && (
              <div className="mt-2 rounded-xl border border-white/80 bg-white/70 p-3 shadow-xs backdrop-blur-md animate-fade-in ring-1 ring-zinc-900/5">
                <div className="mb-2 flex items-center justify-between text-[0.7rem]">
                  <span className="font-semibold tracking-wide uppercase text-zinc-400">
                    Verified Sources & Documents
                  </span>
                  <span className="text-zinc-400">Click to download or view</span>
                </div>
                <ul className="flex flex-wrap gap-2" aria-label="Response sources">
                  {references.map((ref, i) => (
                    <Citation reference={ref} ticketId={ticketId} key={`${ref.sourceId}-${i}`} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
