"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChatComposer } from "./chat-composer";
import { MessageBubble } from "./chat-message";
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

const statusLabels: Record<Ticket["status"], string> = {
  open: "Open",
  awaiting_customer: "Awaiting your reply",
  processing: "In progress",
  closed: "Closed",
};

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  // Preserve stable arrival order for equal timestamps.
  return Array.from(byId.values()).sort((a, b) =>
    (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  );
}

function storageKey(agentKey: string) { return `ai-service-agent.active-ticket.${agentKey}`; }
function storedTicket(agentKey: string) {
  try { return window.localStorage.getItem(storageKey(agentKey)); }
  catch { return null; }
}
function rememberTicket(agentKey: string, ticketId: string | null) {
  try {
    if (ticketId) window.localStorage.setItem(storageKey(agentKey), ticketId);
    else window.localStorage.removeItem(storageKey(agentKey));
  } catch { /* Persistent hint is optional; Node cookie is authoritative. */ }
}

async function initializeTicket(agentKey: string): Promise<TicketHistory> {
  const previousId = storedTicket(agentKey);
  if (previousId) {
    try {
      const history = await getTicket(previousId);
      if (history.ticket.agentKey !== agentKey) throw new ChatApiError("Ticket agent mismatch.", 404, "NOT_FOUND");
      return history;
    } catch (error) {
      // Only 404 means a missing/unauthorized ticket. Never replace a ticket on network/5xx errors.
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
  const initPromise = useRef<Promise<TicketHistory> | null>(null);
  const sendLock = useRef(false);
  const retryRequest = useRef<{ text: string; requestId: string } | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const prevMessageCount = useRef(0);
  const knownMessages = useRef<ChatMessage[]>([]);

  useEffect(() => { knownMessages.current = messages; }, [messages]);

  useEffect(() => {
    let subscribed = true;
    if (!initPromise.current) initPromise.current = initializeTicket(agentKey);
    initPromise.current.then((history) => {
      if (!subscribed) return;
      setTicket(history.ticket);
      setMessages(history.messages);
      setTurnState(history.ticket.status === "processing" ? "processing" : "idle");
      setLoadError(null);
      setLoadState("ready");
    }).catch((error: unknown) => {
      if (!subscribed) return;
      setLoadError(displayError(error));
      setLoadState("error");
    });
    return () => { subscribed = false; };
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

  const refresh = useCallback(async () => {
    if (!ticket) return;
    try {
      const history = await getTicket(ticket.id);
      if (history.ticket.agentKey !== agentKey) throw new ChatApiError("Ticket agent mismatch.", 404, "NOT_FOUND");
      setTicket(history.ticket);
      const sawNewReply = history.messages.some((message) =>
        message.role === "assistant" && !knownMessages.current.some((old) => old.id === message.id),
      );
      setMessages((current) => mergeMessages(current, history.messages));
      if (sawNewReply) setTurnState("idle");
    } catch (error) {
      if (error instanceof ChatApiError && error.status === 404) {
        rememberTicket(agentKey, null);
        setTicket(null);
        setMessages([]);
        setLoadState("error");
        setLoadError("This conversation is no longer available to your session. Start a new conversation.");
      } else {
        setSendError(displayError(error));
      }
    }
  }, [agentKey, ticket?.id]); // Do not reconnect just because ticket subject/status changes.

  const handleEvent = useCallback((event: TicketEvent) => {
    const incomingMessage = messageFromEvent(event.data);
    const incomingTicket = ticketFromEvent(event.data);
    if (incomingTicket && incomingTicket.id === ticket?.id && incomingTicket.agentKey === agentKey) setTicket(incomingTicket);

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
        // Unknown events and tool telemetry are deliberately not rendered.
        break;
    }
  }, [agentKey, ticket?.id, refresh]);

  const stream = useTicketEvents(ticket?.id ?? null, handleEvent, refresh);

  const send = useCallback(async (text: string) => {
    if (!ticket || sendLock.current || ticket.status === "closed") throw new Error("Conversation unavailable");
    sendLock.current = true;
    setTurnState("sending");
    setSendError(null);
    const previous = retryRequest.current;
    const requestId = previous?.text === text ? previous.requestId : crypto.randomUUID();
    retryRequest.current = { text, requestId };
    try {
      const accepted = await sendCustomerMessage(ticket.id, text, requestId);
      retryRequest.current = null;
      // 202 proves durable acceptance of the customer message, not an AI answer.
      setMessages((current) => mergeMessages(current, [{
        id: accepted.messageId,
        role: "customer",
        text,
        createdAt: new Date().toISOString(),
      }]));
      setTurnState((state) => state === "idle" || state === "processing" ? state : "accepted");
      void refresh();
    } catch (error) {
      setTurnState("idle");
      setSendError(`${displayError(error)} The draft is still available to retry.`);
      throw error;
    } finally {
      sendLock.current = false;
    }
  }, [ticket?.id, ticket?.status, refresh]);

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

  const isSending = turnState === "sending";
  const isProcessing = turnState === "accepted" || turnState === "processing" ||
    (ticket?.status === "processing" && turnState !== "sending");
  const locked = loadState !== "ready" || !ticket || ticket.status === "closed" || isProcessing;

  return (
    <main className="flex h-dvh min-h-[24rem] flex-col bg-[#f7f9fc] text-slate-900">
      <header className="z-10 shrink-0 border-b border-slate-200/80 bg-white/95">
        <div className="mx-auto flex w-full max-w-4xl items-center gap-3 px-4 py-3 sm:px-8 sm:py-4">
          <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-blue-700 text-lg font-semibold text-white">S</span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">Sara <span className="ml-1 text-xs font-medium text-slate-400">· ANCFZ</span></h1>
            <p className="text-xs text-slate-500">Customer service assistant</p>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            {ticket && <span className="max-w-32 truncate text-xs font-medium text-slate-700 sm:max-w-none" title={ticket.number}>{ticket.number} · {statusLabels[ticket.status]}</span>}
            <span className="flex items-center gap-1.5 text-[0.7rem] text-slate-500" role="status">
              <span aria-hidden="true" className={`size-1.5 rounded-full ${stream === "connected" ? "bg-emerald-500" : "bg-amber-500"}`} />
              {stream === "connected" ? "Connected" : stream === "reconnecting" ? "Reconnecting" : stream === "connecting" ? "Connecting" : "Not connected"}
            </span>
          </div>
        </div>
        {ticket?.subject && <div className="mx-auto w-full max-w-4xl truncate px-4 pb-2 text-xs text-slate-500 sm:px-8" title={ticket.subject}>{ticket.subject}</div>}
      </header>

      <section ref={transcriptRef} onScroll={onTranscriptScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-label="Conversation history">
        <div className={`mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-8 sm:py-8 ${!messages.length ? "justify-center" : ""}`}>
          {loadState === "loading" && <p role="status" className="text-center text-sm text-slate-500">Opening your conversation…</p>}
          {loadState === "error" && (
            <div className="mx-auto max-w-md rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm" role="alert">
              <h2 className="font-semibold">Unable to open the conversation</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{loadError}</p>
              <button type="button" onClick={restart} className="mt-4 rounded-xl bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">Try again</button>
            </div>
          )}
          {loadState === "ready" && messages.length === 0 && (
            <div className="mx-auto max-w-md text-center">
              <span aria-hidden="true" className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl border border-blue-100 bg-blue-50 text-2xl text-blue-700">✳</span>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">How can Sara help?</h2>
              <p className="mt-3 text-sm leading-7 text-slate-500">Start a conversation with Sara about ANCFZ services or a question you have. Your messages will appear here.</p>
            </div>
          )}
          {messages.length > 0 && <ol role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions" className="space-y-6">{messages.map((message) => <MessageBubble message={message} key={message.id} />)}</ol>}
          {loadState === "ready" && (isSending || isProcessing) && (
            <div role="status" aria-live="polite" className="mt-6 flex items-center gap-2 pl-11 text-xs text-slate-500">
              <span aria-hidden="true" className="flex gap-1"><i className="size-1.5 animate-pulse rounded-full bg-blue-500" /><i className="size-1.5 animate-pulse rounded-full bg-blue-500 [animation-delay:200ms]" /><i className="size-1.5 animate-pulse rounded-full bg-blue-500 [animation-delay:400ms]" /></span>
              {isSending ? "Sending your message…" : turnState === "accepted" ? "Message received. Waiting for Sara…" : "Sara is working on your reply…"}
            </div>
          )}
        </div>
      </section>

      <div className="relative shrink-0 border-t border-slate-200/70 bg-[#f7f9fc] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-5">
        {showLatest && <button type="button" onClick={() => { const panel = transcriptRef.current; panel?.scrollTo({ top: panel.scrollHeight, behavior: "smooth" }); followLatest.current = true; setShowLatest(false); }} className="absolute -top-11 left-1/2 -translate-x-1/2 rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-blue-700 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">Latest messages ↓</button>}
        <div className="mx-auto w-full max-w-3xl">
          {stream === "reconnecting" && <p role="status" className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Connection interrupted. Reconnecting to your conversation…</p>}
          {loadState === "ready" && stream === "disconnected" && <p role="status" className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Live updates are disconnected. You can reload the page to reconnect.</p>}
          {operationNotice && <p role="status" className="mb-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900">{operationNotice}</p>}
          {sendError && <p role="alert" className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{sendError}</p>}
          <ChatComposer onSend={send} disabled={locked} sending={isSending} />
          {ticket?.status === "closed" && <p role="status" className="mt-1 text-center text-xs text-slate-500">This ticket is closed. Messages are read-only.</p>}
        </div>
      </div>
    </main>
  );
}
