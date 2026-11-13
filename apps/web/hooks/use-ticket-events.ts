"use client";

import { useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface TicketEvent {
  id: string | null;
  name: string;
  data: unknown;
}

// The P0 OpenAPI freezes the SSE route and cursor, but not payload envelopes.
// Support both named events and default 'message' frames without assuming model completion.
const eventNames = [
  "ticket.created",
  "ticket.subject.updated",
  "ticket.status.updated",
  "ticket.updated",
  "message.accepted",
  "assistant.processing",
  "assistant.reply",
  "assistant.failed",
  "agent.processing",
  "agent.response.started",
  "agent.response.completed",
  "agent.response.failed",
  "message.processing.failed",
  "operation.status.updated",
  "operation.queued",
  "operation.running",
  "operation.completed",
  "operation.failed",
];

export function useTicketEvents(
  ticketId: string | null,
  onEvent: (event: TicketEvent) => void,
  onConnected: () => void,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("disconnected");
  const eventHandler = useRef(onEvent);
  const connectedHandler = useRef(onConnected);

  useEffect(() => { eventHandler.current = onEvent; }, [onEvent]);
  useEffect(() => { connectedHandler.current = onConnected; }, [onConnected]);

  useEffect(() => {
    if (!ticketId) return;
    const source = new EventSource(`/api/events/tickets/${encodeURIComponent(ticketId)}`, {
      withCredentials: true,
    });
    const seen = new Set<string>();
    const order: string[] = [];
    setStatus("connecting");

    function dispatch(name: string, event: MessageEvent<string>) {
      let data: unknown;
      try { data = JSON.parse(event.data); }
      catch { return; } // SSE keepalives and malformed events cannot become chat content.
      const envelope = data && typeof data === "object" && !Array.isArray(data)
        ? data as Record<string, unknown> : null;
      const id = event.lastEventId ||
        (typeof envelope?.eventId === "string" ? envelope.eventId : null) ||
        (typeof envelope?.cursor === "string" ? envelope.cursor : null);
      if (id) {
        if (seen.has(id)) return;
        seen.add(id);
        order.push(id);
        if (order.length > 512) seen.delete(order.shift()!);
      }
      const resolvedName = name === "message" && typeof envelope?.type === "string"
        ? envelope.type
        : name === "message" && typeof envelope?.event === "string"
          ? envelope.event
          : name;
      eventHandler.current({ id, name: resolvedName, data });
    }

    source.onopen = () => {
      setStatus("connected");
      // Reconcile against the authorized PostgreSQL snapshot after each connection.
      // Native EventSource handles Last-Event-ID automatically while reconnecting.
      connectedHandler.current();
    };
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED
      ? "disconnected"
      : "reconnecting");

    source.onmessage = (event) => dispatch("message", event);
    const listeners = eventNames.map((name) => {
      const listener = (event: Event) => dispatch(name, event as MessageEvent<string>);
      source.addEventListener(name, listener);
      return { name, listener };
    });
    return () => {
      listeners.forEach(({ name, listener }) => source.removeEventListener(name, listener));
      source.close();
    };
  }, [ticketId]);

  return ticketId ? status : "disconnected";
}
