import { randomBytes } from "node:crypto";
import { PersistenceDatabase, PersistenceError, requireBounded, requireUuid } from "../database/pool.js";
import { publishedBinding } from "./agent.js";
import { appendEventTx } from "./events.js";
import {
  asIso, authorizedTicket, hashGuestToken, ownerParameters, pageSize,
  ticketFromRow, type TicketRecord, type TicketScope,
} from "./types.js";

export class GuestSessionRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async create(agentId: string, ttlSeconds = 604_800): Promise<{ token: string; expiresAt: string }> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 2_592_000) {
      throw new PersistenceError("INVALID_INPUT", "Invalid session TTL");
    }
    const token = randomBytes(32).toString("hex");
    return this.db.withAgent(agentId, async (client) => {
      await publishedBinding(client, agentId);
      const result = await client.query<{ expires_at: Date }>(
        "INSERT INTO guest_sessions (agent_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 second')) RETURNING expires_at",
        [agentId, hashGuestToken(token), ttlSeconds],
      );
      return { token, expiresAt: asIso(result.rows[0]?.expires_at ?? null) as string };
    });
  }

  async isValid(agentId: string, token: string): Promise<boolean> {
    const hashed = hashGuestToken(token);
    return this.db.withAgent(agentId, async (client) => {
      const result = await client.query(
        "SELECT 1 FROM guest_sessions WHERE agent_id = $1 AND token_hash = $2 AND expires_at > now() LIMIT 1",
        [agentId, hashed],
      );
      return result.rowCount === 1;
    });
  }
}

export class TicketRepository {
  constructor(private readonly db: PersistenceDatabase) {}

  async create(scope: TicketScope, subject = "New enquiry"): Promise<TicketRecord> {
    requireBounded(subject, "subject", 200);
    return this.db.withAgent(scope.agentId, async (client) => {
      const [hash, accountId] = ownerParameters(scope);
      let guestSessionId: string | null = null;
      if (scope.owner.kind === "guest") {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM guest_sessions WHERE agent_id = $1 AND token_hash = $2 AND expires_at > now()",
          [scope.agentId, hash],
        );
        guestSessionId = existing.rows[0]?.id ?? null;
        if (!guestSessionId) throw new PersistenceError("NOT_FOUND", "Guest session not found");
      } else {
        const verified = await client.query(
          "SELECT 1 FROM agent_accounts WHERE agent_id = $1 AND id = $2 AND email_verified_at IS NOT NULL",
          [scope.agentId, accountId],
        );
        if (verified.rowCount !== 1) throw new PersistenceError("NOT_FOUND", "Verified account not found");
      }
      const binding = await publishedBinding(client, scope.agentId);
      if (!binding.intentCatalogVersionId || !binding.offeringCatalogVersionId) {
        throw new PersistenceError("NOT_CONFIGURED", "Published catalogs required for new tickets");
      }
      const result = await client.query<Record<string, unknown>>(
        [
          "INSERT INTO tickets (agent_id, agent_version_id, intent_catalog_version_id,",
          "offering_catalog_version_id, guest_session_id, account_id, subject)",
          "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
        ].join(" "),
        [scope.agentId, binding.versionId, binding.intentCatalogVersionId,
          binding.offeringCatalogVersionId, guestSessionId, accountId, subject],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("DATABASE_ERROR", "Ticket creation returned no row");
      await appendEventTx(client, scope.agentId, String(row["id"]), "ticket.created", {
        ticketId: row["id"], subject,
      });
      return ticketFromRow(row);
    });
  }

  async get(scope: TicketScope, ticketId: string): Promise<TicketRecord> {
    return this.db.withAgent(scope.agentId, async (client) =>
      ticketFromRow(await authorizedTicket(client, scope, ticketId)));
  }

  async listForVerifiedAccount(scope: TicketScope, limit = 50): Promise<TicketRecord[]> {
    if (scope.owner.kind !== "verified_account") {
      throw new PersistenceError("NOT_FOUND", "Verified account required");
    }
    const take = pageSize(limit);
    return this.db.withAgent(scope.agentId, async (client) => {
      const checked = await client.query(
        "SELECT 1 FROM agent_accounts WHERE agent_id = $1 AND id = $2 AND email_verified_at IS NOT NULL",
        [scope.agentId, requireUuid(scope.owner.accountId, "accountId")],
      );
      if (checked.rowCount !== 1) throw new PersistenceError("NOT_FOUND", "Verified account not found");
      const result = await client.query<Record<string, unknown>>(
        "SELECT * FROM tickets WHERE agent_id = $1 AND account_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3",
        [scope.agentId, scope.owner.accountId, take],
      );
      return result.rows.map(ticketFromRow);
    });
  }

  async setStatus(
    scope: TicketScope, ticketId: string,
    status: TicketRecord["status"],
    options: { confirmedCustomerClosure?: boolean } = {},
  ): Promise<TicketRecord> {
    if (!["open", "awaiting_customer", "processing", "closed"].includes(status)) {
      throw new PersistenceError("INVALID_INPUT", "Invalid ticket status");
    }
    if (status === "closed" && options.confirmedCustomerClosure !== true) {
      throw new PersistenceError("CONFLICT", "Customer closure confirmation required");
    }
    return this.db.withAgent(scope.agentId, async (client) => {
      const existing = await authorizedTicket(client, scope, ticketId, true);
      if (existing["status"] === "closed" && status !== "closed") {
        throw new PersistenceError("CONFLICT", "Closed ticket cannot be reopened implicitly");
      }
      if (existing["status"] === status) return ticketFromRow(existing);
      const changed = await client.query<Record<string, unknown>>(
        "UPDATE tickets SET status = $3, updated_at = now(), closed_at = CASE WHEN $3 = 'closed' THEN now() ELSE NULL END WHERE agent_id = $1 AND id = $2 RETURNING *",
        [scope.agentId, ticketId, status],
      );
      await appendEventTx(client, scope.agentId, ticketId,
        status === "closed" ? "ticket.closed" : "ticket.status.updated",
        { status });
      return ticketFromRow(changed.rows[0] as Record<string, unknown>);
    });
  }

  // Customer first proves ownership of the guest session and then completes
  // account verification in Node; this method never performs OTP verification.
  async linkVerifiedAccount(
    scope: TicketScope, ticketId: string, verifiedAccountId: string,
  ): Promise<TicketRecord> {
    if (scope.owner.kind !== "guest") {
      throw new PersistenceError("CONFLICT", "Guest ownership is required for account upgrade");
    }
    requireUuid(verifiedAccountId, "verifiedAccountId");
    return this.db.withAgent(scope.agentId, async (client) => {
      const ticket = await authorizedTicket(client, scope, ticketId, true);
      if (ticket["account_id"] !== null) throw new PersistenceError("CONFLICT", "Ticket already linked");
      const account = await client.query(
        "SELECT 1 FROM agent_accounts WHERE agent_id = $1 AND id = $2 AND email_verified_at IS NOT NULL",
        [scope.agentId, verifiedAccountId],
      );
      if (account.rowCount !== 1) throw new PersistenceError("NOT_FOUND", "Verified account not found");
      const result = await client.query<Record<string, unknown>>(
        "UPDATE tickets SET account_id = $3, guest_session_id = NULL, updated_at = now() WHERE agent_id = $1 AND id = $2 RETURNING *",
        [scope.agentId, ticketId, verifiedAccountId],
      );
      await appendEventTx(client, scope.agentId, ticketId, "auth.session.verified",
        { ticketId, accountLinked: true });
      return ticketFromRow(result.rows[0] as Record<string, unknown>);
    });
  }
}
