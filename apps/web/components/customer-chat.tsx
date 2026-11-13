"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatComposer } from "./chat-composer";
import { LeadSubmission } from "./lead-submission";
import { QuotationRequest } from "./quotation-request";
import { MessageBubble } from "./chat-message";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  BuildingIcon,
  CheckIcon,
  ClipboardCheckIcon,
  CopyIcon,
  PassportIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "./icons";
import {
  ChatApiError,
  createTicket,
  eventFailureMessage,
  getTicket,
  messageFromEvent,
  sendCustomerMessage,
  ticketFromEvent,
  type ChatMessage,
  type Ticket,
  type TicketHistory,
} from "../lib/chat-api";
import { useTicketEvents, type TicketEvent } from "../hooks/use-ticket-events";

type LoadState = "loading" | "ready" | "error";
type TurnState = "idle" | "sending" | "accepted" | "processing";

const statusConfig: Record<Ticket["status"], { label: string; badgeClass: string }> = {
  open: {
    label: "Open",
    badgeClass: "bg-emerald-50/80 text-emerald-800 border-emerald-200/80",
  },
  awaiting_customer: {
    label: "Awaiting reply",
    badgeClass: "bg-zinc-100/80 text-zinc-800 border-zinc-200/80",
  },
  processing: {
    label: "In progress",
    badgeClass: "bg-amber-50/80 text-amber-800 border-amber-200/80",
  },
  closed: {
    label: "Closed",
    badgeClass: "bg-zinc-100/80 text-zinc-500 border-zinc-200",
  },
};

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values()).sort(
    (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  );
}

function storageKey(agentKey: string) {
  return `ai-service-agent.active-ticket.${agentKey}`;
}

function storedTicket(agentKey: string) {
  try {
    return window.localStorage.getItem(storageKey(agentKey));
  } catch {
    return null;
  }
}

function rememberTicket(agentKey: string, ticketId: string | null) {
  try {
    if (ticketId) window.localStorage.setItem(storageKey(agentKey), ticketId);
    else window.localStorage.removeItem(storageKey(agentKey));
  } catch {
    /* Persistent hint is optional; Node cookie is authoritative. */
  }
}

async function initializeTicket(agentKey: string): Promise<TicketHistory> {
  const previousId = storedTicket(agentKey);
  if (previousId) {
    try {
      const history = await getTicket(previousId);
      if (history.ticket.agentKey !== agentKey)
        throw new ChatApiError("Ticket agent mismatch.", 404, "NOT_FOUND");
      return history;
    } catch (error) {
      if (!(error instanceof ChatApiError) || error.status !== 404) throw error;
      rememberTicket(agentKey, null);
    }
  }
  const ticket = await createTicket(agentKey);
  rememberTicket(agentKey, ticket.id);
  return { ticket, messages: [] };
}

function displayError(error: unknown): string {
  if (error instanceof ChatApiError) return error.message;
  return "Something went wrong. Please try again.";
}

const STARTER_PROMPTS = [
  {
    icon: BuildingIcon,
    title: "Business Licensing",
    description: "Requirements, categories, and steps to apply for an ANCFZ trade license.",
    prompt: "What are the requirements and steps to apply for a new business license in ANCFZ?",
  },
  {
    icon: PassportIcon,
    title: "Visa & Residency",
    description: "Investor and employment visas, family sponsorship, and processing times.",
    prompt: "What are the requirements and process for investor and employment visas in ANCFZ?",
  },
  {
    icon: ClipboardCheckIcon,
    title: "Company Setup Docs",
    description: "Legal documents, shareholder resolutions, and compliance approvals.",
    prompt: "What documents and approvals are required to register a company in ANCFZ?",
  },
  {
    icon: ShieldCheckIcon,
    title: "Track Application",
    description: "Inquire about existing ticket progress, requirements, and next steps.",
    prompt: "Can you help me check the status and requirements for my current ticket?",
  },
];

export function CustomerChat({ agentKey }: { agentKey: string }) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [turnState, setTurnState] = useState<TurnState>("idle");
  const [retryNonce, setRetryNonce] = useState(0);
  const [showLatest, setShowLatest] = useState(false);
  const [copiedTicket, setCopiedTicket] = useState(false);
  const [prefilledPrompt, setPrefilledPrompt] = useState<string | null>(null);

  const initPromise = useRef<Promise<TicketHistory> | null>(null);
  const sendLock = useRef(false);
  const retryRequest = useRef<{ text: string; requestId: string } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const prevMessageCount = useRef(0);
  const knownMessages = useRef<ChatMessage[]>([]);

  useEffect(() => {
    knownMessages.current = messages;
  }, [messages]);

  useEffect(() => {
    let subscribed = true;
    if (!initPromise.current) initPromise.current = initializeTicket(agentKey);
    initPromise.current
      .then((history) => {
        if (!subscribed) return;
        setTicket(history.ticket);
        setMessages(history.messages);
        setTurnState(history.ticket.status === "processing" ? "processing" : "idle");
        setLoadError(null);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (!subscribed) return;
        setLoadError(displayError(error));
        setLoadState("error");
      });
    return () => {
      subscribed = false;
    };
  }, [agentKey, retryNonce]);

  const restart = useCallback(() => {
    initPromise.current = null;
    retryRequest.current = null;
    setTicket(null);
    setMessages([]);
    setTurnState("idle");
    setSendError(null);
    setLoadError(null);
    setLoadState("loading");
    setRetryNonce((value) => value + 1);
  }, []);

  const startNewConversation = useCallback(() => {
    rememberTicket(agentKey, null);
    restart();
  }, [agentKey, restart]);

  const refresh = useCallback(async () => {
    if (!ticket) return;
    try {
      const history = await getTicket(ticket.id);
      if (history.ticket.agentKey !== agentKey)
        throw new ChatApiError("Ticket agent mismatch.", 404, "NOT_FOUND");
      setTicket(history.ticket);
      const sawNewReply = history.messages.some(
        (message) =>
          message.role === "assistant" &&
          !knownMessages.current.some((old) => old.id === message.id),
      );
      setMessages((current) => mergeMessages(current, history.messages));
      if (sawNewReply) setTurnState("idle");
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 404) {
        rememberTicket(agentKey, null);
        setTicket(null);
        setMessages([]);
        setLoadState("error");
        setLoadError(
          "This conversation is no longer available to your session. Start a new conversation.",
        );
      } else {
        setSendError(displayError(error));
      }
    }
  }, [agentKey, ticket?.id]);

  const handleEvent = useCallback(
    (event: TicketEvent) => {
      const incomingMessage = messageFromEvent(event.data);
      const incomingTicket = ticketFromEvent(event.data);
      if (
        incomingTicket &&
        incomingTicket.id === ticket?.id &&
        incomingTicket.agentKey === agentKey
      ) {
        setTicket(incomingTicket);
      }

      if (incomingMessage) {
        setMessages((existing) => mergeMessages(existing, [incomingMessage]));
        if (incomingMessage.role === "assistant") {
          setTurnState("idle");
          setSendError(null);
        }
      }

      switch (event.name) {
        case "message.accepted":
          if (!incomingMessage) void refresh();
          break;
        case "agent.processing":
        case "assistant.processing":
        case "agent.response.started":
          setTurnState("processing");
          break;
        case "agent.response.completed":
        case "assistant.reply":
        case "assistant.message":
          if (!incomingMessage) void refresh();
          break;
        case "agent.response.failed":
        case "assistant.failed":
        case "message.processing.failed":
          setTurnState("idle");
          setSendError(eventFailureMessage(event.data));
          break;
        case "operation.queued":
          setOperationNotice("Your request has been queued.");
          break;
        case "operation.running":
          setOperationNotice("Your request is being processed.");
          break;
        case "operation.completed":
          setOperationNotice("The service has reported your request as completed.");
          void refresh();
          break;
        case "operation.failed":
          setOperationNotice("The requested operation failed. Please review with Sara.");
          break;
        case "operation.status.updated":
        case "ticket.updated":
        case "ticket.subject.updated":
        case "ticket.status.updated":
          if (!incomingTicket) void refresh();
          break;
        default:
          break;
      }
    },
    [agentKey, ticket?.id, refresh],
  );

  const stream = useTicketEvents(ticket?.id ?? null, handleEvent, refresh);

  const send = useCallback(
    async (text: string) => {
      if (!ticket || sendLock.current || ticket.status === "closed")
        throw new Error("Conversation unavailable");
      sendLock.current = true;
      setTurnState("sending");
      setSendError(null);
      const previous = retryRequest.current;
      const requestId = previous?.text === text ? previous.requestId : crypto.randomUUID();
      retryRequest.current = { text, requestId };
      try {
        const accepted = await sendCustomerMessage(ticket.id, text, requestId);
        retryRequest.current = null;
        setMessages((current) =>
          mergeMessages(current, [
            {
              id: accepted.messageId,
              role: "customer",
              text,
              createdAt: new Date().toISOString(),
            },
          ]),
        );
        setTurnState((state) =>
          state === "idle" || state === "processing" ? state : "accepted",
        );
        void refresh();
      } catch (error) {
        setTurnState("idle");
        setSendError(`${displayError(error)} The draft is still available to retry.`);
        throw error;
      } finally {
        sendLock.current = false;
      }
    },
    [ticket?.id, ticket?.status, refresh],
  );

  useLayoutEffect(() => {
    const panel = transcriptRef.current;
    if (!panel) return;
    const added = messages.length > prevMessageCount.current;
    prevMessageCount.current = messages.length;
    if (!added) return;
    if (followLatest.current) {
      panel.scrollTo({ top: panel.scrollHeight, behavior: "auto" });
      setShowLatest(false);
    } else {
      setShowLatest(true);
    }
  }, [messages.length]);

  function onTranscriptScroll() {
    const panel = transcriptRef.current;
    if (!panel) return;
    const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100;
    followLatest.current = atBottom;
    if (atBottom) setShowLatest(false);
  }

  async function copyTicketNumber() {
    if (!ticket) return;
    try {
      await navigator.clipboard.writeText(ticket.number);
      setCopiedTicket(true);
      setTimeout(() => setCopiedTicket(false), 2000);
    } catch {
      // Fallback
    }
  }

  const isSending = turnState === "sending";
  const isProcessing =
    turnState === "accepted" ||
    turnState === "processing" ||
    (ticket?.status === "processing" && turnState !== "sending");
  const locked = loadState !== "ready" || !ticket || ticket.status === "closed" || isProcessing;

  const currentStatus = ticket ? statusConfig[ticket.status] : null;

  return (
    <main className="flex h-dvh min-h-[24rem] flex-col text-zinc-900">
      {/* Frosted Glassmorphic Header */}
      <header className="sticky top-0 z-30 shrink-0 border-b border-white/60 bg-white/70 backdrop-blur-xl shadow-[0_4px_24px_rgba(0,0,0,0.02)] ring-1 ring-zinc-900/5">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          {/* Agent Identity */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="relative flex size-10 sm:size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-zinc-950 via-zinc-900 to-zinc-800 text-white shadow-sm ring-2 ring-white/80 border border-white/30 backdrop-blur-md">
              <SparklesIcon className="size-5 sm:size-5.5 text-zinc-200" />
              <span
                aria-hidden="true"
                className={`absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-white ${
                  stream === "connected" ? "bg-emerald-500" : "bg-amber-500 animate-pulse"
                }`}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-base font-semibold tracking-tight text-zinc-900 sm:text-lg">
                  Sara
                </h1>
                <span className="inline-flex items-center rounded-md border border-white/80 bg-white/70 backdrop-blur-md px-1.5 py-0.5 text-[0.68rem] font-medium tracking-wide uppercase text-zinc-800 shadow-2xs">
                  ANCFZ Free Zone
                </span>
              </div>
              <p className="truncate text-xs text-zinc-500">Official AI Customer Service Assistant</p>
            </div>
          </div>

          {/* Ticket Info & Actions with Glassmorphism */}
          <div className="flex items-center gap-2 sm:gap-3">
            {ticket && (
              <div className="hidden sm:flex items-center gap-2">
                {/* Copyable Ticket ID Pill */}
                <button
                  type="button"
                  onClick={copyTicketNumber}
                  title="Click to copy ticket reference"
                  className="group inline-flex items-center gap-1.5 rounded-lg border border-white/70 bg-white/60 backdrop-blur-md px-2.5 py-1 text-xs font-mono font-medium text-zinc-700 shadow-2xs transition-all hover:border-zinc-300 hover:bg-white/90"
                >
                  <span>{ticket.number}</span>
                  {copiedTicket ? (
                    <CheckIcon className="size-3 text-emerald-600" />
                  ) : (
                    <CopyIcon className="size-3 text-zinc-400 group-hover:text-zinc-600" />
                  )}
                </button>

                {/* Status Pill */}
                {currentStatus && (
                  <span
                    className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-xs font-medium backdrop-blur-md shadow-2xs ${currentStatus.badgeClass}`}
                  >
                    {currentStatus.label}
                  </span>
                )}
              </div>
            )}

            {/* Connection Status Pill */}
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/70 bg-white/60 backdrop-blur-md px-2.5 py-1 text-[0.7rem] font-medium text-zinc-600 shadow-2xs"
              role="status"
            >
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${
                  stream === "connected"
                    ? "bg-emerald-500"
                    : stream === "reconnecting" || stream === "connecting"
                      ? "bg-amber-500 animate-pulse"
                      : "bg-zinc-400"
                }`}
              />
              <span className="hidden xs:inline">
                {stream === "connected"
                  ? "Connected"
                  : stream === "reconnecting"
                    ? "Reconnecting"
                    : stream === "connecting"
                      ? "Connecting"
                      : "Offline"}
              </span>
            </span>

            {/* New Conversation Button */}
            {ticket && (
              <button
                type="button"
                onClick={startNewConversation}
                title="Start a new conversation"
                className="inline-flex items-center gap-1 rounded-lg border border-white/70 bg-white/60 backdrop-blur-md px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-2xs transition-all hover:border-zinc-300 hover:bg-white/95 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-zinc-800 active:scale-95"
              >
                <PlusIcon className="size-3.5 text-zinc-500" />
                <span className="hidden sm:inline">New Chat</span>
              </button>
            )}
          </div>
        </div>

        {/* Ticket subject line if present */}
        {ticket?.subject && (
          <div className="mx-auto w-full max-w-4xl border-t border-zinc-200/50 bg-white/40 backdrop-blur-md px-4 py-1.5 sm:px-6">
            <p className="truncate text-xs font-medium text-zinc-600" title={ticket.subject}>
              <span className="text-zinc-400 font-normal">Subject: </span>
              {ticket.subject}
            </p>
          </div>
        )}
      </header>

      {/* Main Transcript Body */}
      <section
        ref={transcriptRef}
        onScroll={onTranscriptScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-label="Conversation history"
      >
        <div
          className={`mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6 sm:py-8 ${
            !messages.length ? "justify-center" : ""
          }`}
        >
          {/* Loading State */}
          {loadState === "loading" && (
            <div role="status" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl border border-white/80 bg-white/70 backdrop-blur-md text-zinc-600 shadow-sm ring-1 ring-zinc-900/5">
                <RefreshCwIcon className="size-6 animate-spin text-zinc-800" />
              </div>
              <p className="text-sm font-medium text-zinc-800">Opening your conversation with Sara…</p>
              <p className="text-xs text-zinc-400">Loading verified ticket records</p>
            </div>
          )}

          {/* Load Error State */}
          {loadState === "error" && (
            <div
              className="mx-auto max-w-md rounded-2xl border border-rose-200/80 bg-white/80 backdrop-blur-md p-6 text-center shadow-lg ring-1 ring-zinc-900/5"
              role="alert"
            >
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-rose-50 text-rose-600 border border-rose-200/60 shadow-xs">
                <AlertCircleIcon className="size-6" />
              </div>
              <h2 className="text-base font-semibold text-zinc-900">Unable to open conversation</h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">{loadError}</p>
              <button
                type="button"
                onClick={restart}
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 active:scale-95 focus-visible:outline-2 focus-visible:outline-zinc-800"
              >
                <RefreshCwIcon className="size-4" />
                <span>Try again</span>
              </button>
            </div>
          )}

          {/* Glassmorphic Empty State with Bento Prompt Starters */}
          {loadState === "ready" && messages.length === 0 && (
            <div className="mx-auto max-w-2xl py-4 animate-fade-in">
              <div className="text-center">
                <div className="relative mx-auto mb-4 inline-flex size-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-zinc-950 via-zinc-900 to-zinc-800 text-white shadow-lg ring-8 ring-white/60 border border-white/30 backdrop-blur-md">
                  <SparklesIcon className="size-7 text-zinc-100" />
                </div>
                <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-900">
                  How can Sara assist you today?
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500 max-w-lg mx-auto">
                  Your direct AI assistant for the Al Nakheel Commercial Free Zone (ANCFZ). Ask about
                  licensing, visa procedures, corporate registration, or ticket status.
                </p>
              </div>

              {/* Bento Grid of Prompt Starters with Frosted Glass Surfaces */}
              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {STARTER_PROMPTS.map((item, idx) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setPrefilledPrompt(item.prompt)}
                      className="group flex flex-col items-start rounded-2xl border border-white/80 bg-white/65 p-4 text-left shadow-[0_4px_20px_rgba(0,0,0,0.03)] backdrop-blur-md transition-all hover:-translate-y-0.5 hover:border-white hover:bg-white/90 hover:shadow-[0_12px_32px_rgba(0,0,0,0.06)] ring-1 ring-zinc-900/5 focus-visible:outline-2 focus-visible:outline-zinc-800 active:scale-[0.99]"
                    >
                      <div className="flex size-9 items-center justify-center rounded-xl bg-zinc-100/90 text-zinc-800 shadow-2xs transition-colors group-hover:bg-zinc-900 group-hover:text-white">
                        <Icon className="size-4.5" />
                      </div>
                      <h3 className="mt-3 text-sm font-semibold text-zinc-900 group-hover:text-zinc-950 transition-colors">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                        {item.description}
                      </p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 flex items-center justify-center gap-2 text-xs text-zinc-400">
                <ShieldCheckIcon className="size-4 text-zinc-600" />
                <span>Verified responses powered by published ANCFZ regulations and guidelines</span>
              </div>
            </div>
          )}

          {/* Conversation History */}
          {messages.length > 0 && (
            <ol
              role="log"
              aria-label="Chat messages"
              aria-live="polite"
              aria-relevant="additions"
              className="space-y-6"
            >
              {messages.map((message) => (
                <MessageBubble message={message} ticketId={ticket?.id} key={message.id} />
              ))}
            </ol>
          )}

          {/* Natural Frosted Glass Thinking Indicator */}
          {loadState === "ready" && (isSending || isProcessing) && (
            <div
              role="status"
              aria-live="polite"
              className="mt-6 flex items-start gap-3 pl-1 sm:pl-2 animate-fade-in"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-zinc-950 via-zinc-900 to-zinc-800 text-white shadow-sm ring-2 ring-white/80 border border-white/20">
                <SparklesIcon className="size-4.5 text-zinc-200 animate-pulse" />
              </div>

              {/* Frosted Glass Thinking Card */}
              <div className="rounded-2xl rounded-tl-xs border border-white/80 bg-white/75 backdrop-blur-md px-4 py-3 shadow-[0_4px_20px_rgba(0,0,0,0.04)] ring-1 ring-zinc-900/5">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="flex items-center gap-1.5">
                    <span className="size-2 animate-bounce rounded-full bg-zinc-800" />
                    <span className="size-2 animate-bounce rounded-full bg-zinc-800 [animation-delay:180ms]" />
                    <span className="size-2 animate-bounce rounded-full bg-zinc-800 [animation-delay:360ms]" />
                  </span>
                  <span className="text-xs font-medium text-zinc-800">
                    {isSending ? "Sending…" : "Thinking…"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Modern Frosted Glass Composer Island Area */}
      <footer className="relative shrink-0 border-t border-white/60 bg-white/65 backdrop-blur-xl px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5 shadow-[0_-4px_24px_rgba(0,0,0,0.02)]">
        {/* Floating Jump to Latest Button */}
        {showLatest && (
          <button
            type="button"
            onClick={() => {
              const panel = transcriptRef.current;
              panel?.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
              followLatest.current = true;
              setShowLatest(false);
            }}
            className="absolute -top-11 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-white/80 bg-white/85 px-4 py-1.5 text-xs font-medium text-zinc-800 shadow-lg backdrop-blur-md transition-all hover:bg-white hover:shadow-xl active:scale-95"
          >
            <span>Latest messages</span>
            <ArrowDownIcon className="size-3.5" />
          </button>
        )}

        <div className="mx-auto w-full max-w-3xl">
          {/* Notifications & Warning Alerts */}
          {stream === "reconnecting" && (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 backdrop-blur-md px-3 py-2 text-xs text-amber-900 shadow-2xs"
            >
              <RefreshCwIcon className="size-3.5 animate-spin text-amber-700 shrink-0" />
              <span>Connection interrupted. Reconnecting to your live session…</span>
            </div>
          )}

          {loadState === "ready" && stream === "disconnected" && (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 backdrop-blur-md px-3 py-2 text-xs text-amber-900 shadow-2xs"
            >
              <AlertCircleIcon className="size-3.5 text-amber-700 shrink-0" />
              <span>Live updates are disconnected. Please reload to reconnect.</span>
            </div>
          )}

          {operationNotice && (
            <div
              role="status"
              className="mb-2 flex items-center gap-2 rounded-xl border border-white/80 bg-white/70 backdrop-blur-md px-3 py-2 text-xs font-medium text-zinc-800 shadow-2xs"
            >
              <SparklesIcon className="size-3.5 text-zinc-700 shrink-0" />
              <span>{operationNotice}</span>
            </div>
          )}

          {sendError && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-2 rounded-xl border border-rose-200/80 bg-rose-50/80 backdrop-blur-md px-3.5 py-2 text-sm text-rose-800 shadow-2xs"
            >
              <AlertCircleIcon className="size-4 text-rose-600 shrink-0" />
              <span className="flex-1">{sendError}</span>
            </div>
          )}

          {/* Customer authorized lead operations and quotations */}
          {ticket && <LeadSubmission key={ticket.id} ticketId={ticket.id} />}
          {ticket && <QuotationRequest key={ticket.id} ticketId={ticket.id} />}

          <ChatComposer
            onSend={send}
            disabled={locked}
            sending={isSending}
            prefilledPrompt={prefilledPrompt}
            onClearPrefilledPrompt={() => setPrefilledPrompt(null)}
          />

          {ticket?.status === "closed" && (
            <div
              role="status"
              className="mt-2 text-center text-xs font-medium text-zinc-500"
            >
              This ticket is closed.{" "}
              <button
                type="button"
                onClick={startNewConversation}
                className="text-zinc-900 underline hover:text-black font-semibold"
              >
                Start a new conversation
              </button>
            </div>
          )}
        </div>
      </footer>
    </main>
  );
}
