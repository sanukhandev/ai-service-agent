import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { PersistenceError, requireUuid } from "../database/pool.js";

export type TicketOwner =
  | { readonly kind: "guest"; readonly token: string }
  | { readonly kind: "verified_account"; readonly accountId: string }
  | { readonly kind: "internal"; readonly ticketId: string; readonly permit: symbol };

const INTERNAL_TURN_PERMIT = Symbol("node-worker-ticket");

/** Only the queue worker may manufacture an internal ticket scope from a DB claim. */
export function workerTicketScope(agentId: string, ticketId: string): TicketScope {
  return { agentId: requireUuid(agentId, "agentId"), owner: { kind: "internal", ticketId: requireUuid(ticketId, "ticketId"), permit: INTERNAL_TURN_PERMIT } };
}

// The API must construct this from a verified backend session, never from
// a Foundry function argument or an unverified request-body account ID.
export interface TicketScope {
  readonly agentId: string;
  readonly owner: TicketOwner;
}

export interface SourceReference {
  readonly sourceId: string;
  readonly title?: string | null;
  readonly uri?: string | null;
  readonly revision?: string | null;
}

export interface TicketRecord {
  id: string;
  agentId: string;
  agentVersionId: string;
  intentCatalogVersionId: string | null;
  offeringCatalogVersionId: string | null;
  ticketNumber: string;
  subject: string;
  status: "open" | "awaiting_customer" | "processing" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface MessageRecord {
  id: string;
  ticketId: string;
  role: "customer" | "assistant";
  text: string;
  requestId: string | null;
  sequence: string;
  sourceReferences: SourceReference[];
  createdAt: string;
}

export interface EventRecord {
  id: string;
  ticketId: string;
  sequence: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function hashGuestToken(token: string): string {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    throw new PersistenceError("INVALID_INPUT", "Invalid session token");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function ownerParameters(scope: TicketScope): [string | null, string | null] {
  requireUuid(scope.agentId, "agentId");
  if (scope.owner.kind === "guest") return [hashGuestToken(scope.owner.token), null];
  if (scope.owner.kind === "verified_account") return [null, requireUuid(scope.owner.accountId, "accountId")];
  throw new PersistenceError("NOT_FOUND", "Internal work scope is not a customer ownership claim");
}

export function cursor(value: string | undefined): string {
  if (value === undefined) return "0";
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new PersistenceError("INVALID_INPUT", "Invalid sequence cursor");
  }
  return value;
}

export function pageSize(value: number | undefined, maximum = 100): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PersistenceError("INVALID_INPUT", "Invalid page size");
  }
  return value;
}

export function asIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

// Scope + owner are checked inside the SAME transaction as the requested
// read/write. A guessed ticket UUID cannot grant access.
export async function authorizedTicket(
  client: PoolClient,
  scope: TicketScope,
  ticketId: string,
  lock = false,
): Promise<Record<string, unknown>> {
  requireUuid(ticketId, "ticketId");
  if (scope.owner.kind === "internal") {
    if (scope.owner.permit !== INTERNAL_TURN_PERMIT || scope.owner.ticketId !== ticketId) {
      throw new PersistenceError("NOT_FOUND", "Ticket not found");
    }
    const internal = await client.query<Record<string, unknown>>(
      `SELECT * FROM tickets WHERE agent_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
      [scope.agentId, ticketId],
    );
    if (!internal.rows[0]) throw new PersistenceError("NOT_FOUND", "Ticket not found");
    return internal.rows[0];
  }
  const [tokenHash, accountId] = ownerParameters(scope);
  const result = await client.query<Record<string, unknown>>(
    [
      "SELECT t.* FROM tickets t WHERE t.agent_id = $1 AND t.id = $2",
      "AND (",
      "($3::text IS NOT NULL AND EXISTS (",
      "SELECT 1 FROM guest_sessions s WHERE s.agent_id = t.agent_id",
      "AND s.id = t.guest_session_id AND s.token_hash = $3 AND s.expires_at > now()",
      ")) OR",
      "($4::uuid IS NOT NULL AND t.account_id = $4 AND EXISTS (",
      "SELECT 1 FROM agent_accounts a WHERE a.agent_id = t.agent_id",
      "AND a.id = $4 AND a.email_verified_at IS NOT NULL",
      "))",
      ")",
      lock ? "FOR UPDATE OF t" : "",
    ].join(" "),
    [scope.agentId, ticketId, tokenHash, accountId],
  );
  const ticket = result.rows[0];
  if (!ticket) throw new PersistenceError("NOT_FOUND", "Ticket not found");
  return ticket;
}

export async function assertAgentActive(client: PoolClient, agentId: string): Promise<void> {
  const active = await client.query(
    "SELECT 1 FROM agents WHERE id = $1 AND status = 'active'",
    [agentId],
  );
  if (active.rowCount !== 1) {
    throw new PersistenceError("CONFLICT", "Agent is not accepting new conversation activity");
  }
}

export function ticketFromRow(row: Record<string, unknown>): TicketRecord {
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    agentVersionId: String(row["agent_version_id"]),
    intentCatalogVersionId: row["intent_catalog_version_id"] as string | null,
    offeringCatalogVersionId: row["offering_catalog_version_id"] as string | null,
    ticketNumber: String(row["ticket_number"]),
    subject: String(row["subject"]),
    status: row["status"] as TicketRecord["status"],
    createdAt: asIso(row["created_at"] as Date) as string,
    updatedAt: asIso(row["updated_at"] as Date) as string,
    closedAt: asIso(row["closed_at"] as Date | null),
  };
}
