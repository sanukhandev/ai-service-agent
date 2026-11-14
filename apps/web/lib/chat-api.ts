/** Public, same-origin API contract: packages/contracts/openapi.yaml (P0). */
export type TicketStatus = "open" | "awaiting_customer" | "processing" | "closed";

export interface Ticket {
  id: string;
  number: string;
  agentKey: string;
  subject?: string | null;
  status: TicketStatus;
  createdAt: string;
}

export interface SourceReference {
  sourceId: string;
  title?: string | null;
  uri?: string | null;
  revision?: string | null;
}

export interface ChatMessage {
  id: string;
  role: "customer" | "assistant";
  text: string;
  createdAt: string;
  sourceReferences?: SourceReference[];
}

export interface TicketHistory {
  ticket: Ticket;
  messages: ChatMessage[];
}

export interface AcceptedMessage {
  ticketId: string;
  messageId: string;
  requestId: string;
  status: "accepted";
}

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validTicket(value: unknown): value is Ticket {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.number === "string" &&
    typeof value.agentKey === "string" &&
    typeof value.createdAt === "string" &&
    ["open", "awaiting_customer", "processing", "closed"].includes(String(value.status)) &&
    (value.subject === undefined || value.subject === null || typeof value.subject === "string")
  );
}

function validSource(value: unknown): value is SourceReference {
  return (
    isRecord(value) &&
    typeof value.sourceId === "string" &&
    ["title", "uri", "revision"].every((field) =>
      value[field] === undefined || value[field] === null || typeof value[field] === "string",
    )
  );
}

export function validMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "customer" || value.role === "assistant") &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string" &&
    (value.sourceReferences === undefined ||
      (Array.isArray(value.sourceReferences) && value.sourceReferences.every(validSource)))
  );
}

function invalidContract(): never {
  throw new ChatApiError("The service returned an unexpected response. Please try again.", 0, "INVALID_CONTRACT");
}

async function request(path: string, init: RequestInit, expectedStatus: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ChatApiError("Cannot reach the service. Check your connection and try again.", 0, "NETWORK_ERROR");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ChatApiError("The service returned an unreadable response.", response.status, "INVALID_RESPONSE");
  }

  if (!response.ok) {
    const problem = isRecord(payload) ? payload : {};
    throw new ChatApiError(
      typeof problem.message === "string" && problem.message.trim()
        ? problem.message
        : `The request failed (HTTP ${response.status}).`,
      response.status,
      typeof problem.code === "string" ? problem.code : "HTTP_ERROR",
      typeof problem.requestId === "string" ? problem.requestId : undefined,
    );
  }
  if (response.status !== expectedStatus) invalidContract();
  return payload;
}

export async function createTicket(agentKey: string): Promise<Ticket> {
  const data = await request(`/api/v1/agents/${encodeURIComponent(agentKey)}/tickets`, { method: "POST" }, 201);
  if (!validTicket(data) || data.agentKey !== agentKey) invalidContract();
  return data;
}

export async function getTicket(ticketId: string): Promise<TicketHistory> {
  const data = await request(`/api/v1/tickets/${encodeURIComponent(ticketId)}`, { method: "GET" }, 200);
  if (!isRecord(data) || !validTicket(data.ticket) || data.ticket.id !== ticketId ||
      !Array.isArray(data.messages) || !data.messages.every(validMessage)) invalidContract();
  return data as unknown as TicketHistory;
}

export async function sendCustomerMessage(
  ticketId: string,
  text: string,
  requestId: string,
): Promise<AcceptedMessage> {
  const data = await request(`/api/v1/tickets/${encodeURIComponent(ticketId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ requestId, text }),
  }, 202);
  if (!isRecord(data) || data.ticketId !== ticketId || data.requestId !== requestId ||
      data.status !== "accepted" || typeof data.messageId !== "string") invalidContract();
  return data as unknown as AcceptedMessage;
}

/** Safely extract a frozen-contract ChatMessage from a future SSE envelope. */
export function messageFromEvent(data: unknown): ChatMessage | null {
  if (validMessage(data)) return data;
  if (!isRecord(data)) return null;
  if (validMessage(data.message)) return data.message;
  if (validMessage(data.reply)) return data.reply;
  if (isRecord(data.payload)) return messageFromEvent(data.payload);
  return null;
}

export function ticketFromEvent(data: unknown): Ticket | null {
  if (validTicket(data)) return data;
  if (isRecord(data) && validTicket(data.ticket)) return data.ticket;
  if (isRecord(data) && isRecord(data.payload)) return ticketFromEvent(data.payload);
  return null;
}

export function eventFailureMessage(data: unknown): string {
  if (!isRecord(data)) return "Sara could not complete that response. Please try again.";
  if (isRecord(data.error) && typeof data.error.message === "string") return data.error.message;
  if (isRecord(data.payload)) return eventFailureMessage(data.payload);
  if (typeof data.message === "string") return data.message;
  return "Sara could not complete that response. Please try again.";
}
