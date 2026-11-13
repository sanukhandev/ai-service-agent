import { Pool, type PoolClient, type PoolConfig } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PersistenceError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "DATABASE_ERROR" | "NOT_CONFIGURED",
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PersistenceError";
  }
}

export function requireUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new PersistenceError("INVALID_INPUT", "Invalid " + field);
  }
  return value;
}

export function requireBounded(value: string, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new PersistenceError("INVALID_INPUT", "Invalid " + field);
  }
  return value.trim();
}

export function dbError(error: unknown): Error {
  if (error instanceof PersistenceError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505" || code === "23503" || code === "23514") {
    return new PersistenceError("CONFLICT", "Persistence constraint rejected the operation", error);
  }
  return new PersistenceError("DATABASE_ERROR", "Database operation failed", error);
}

export class PersistenceDatabase {
  readonly pool: Pool;

  constructor(databaseUrl: string | undefined, config: Pick<PoolConfig, "max" | "idleTimeoutMillis" | "connectionTimeoutMillis"> = {}) {
    // Compose P0 supplies PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD.
    // DATABASE_URL remains an optional explicit override, never a requirement.
    // The runtime-role assertion below refuses privileged connections.
    const connectionString = databaseUrl?.trim() || undefined;
    if (!connectionString && (!process.env.PGHOST || !process.env.PGDATABASE ||
        !process.env.PGUSER || !process.env.PGPASSWORD)) {
      throw new PersistenceError("NOT_CONFIGURED", "Set DATABASE_URL or the complete PGHOST/PGDATABASE/PGUSER/PGPASSWORD configuration");
    }
    this.pool = new Pool({
      ...(connectionString ? { connectionString } : {}),
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    });
  }

  // Invoke at API startup. A migration superuser MUST NOT be used for requests.
  async assertSafeRuntimeRole(): Promise<void> {
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw dbError(error); }
    try {
      const result = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; member: boolean }>(
        "SELECT r.rolsuper, r.rolbypassrls, (current_user = 'agent_runtime') AS member FROM pg_roles r WHERE r.rolname = current_user",
      );
      const row = result.rows[0];
      if (!row || row.rolsuper || row.rolbypassrls || !row.member) {
        throw new PersistenceError("NOT_CONFIGURED", "Application must connect as P0 agent_runtime without superuser or bypass-RLS privileges");
      }
    } catch (error) { throw dbError(error); } finally {
      client.release();
    }
  }

  async withAgent<T>(agentId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    requireUuid(agentId, "agentId");
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch (error) { throw dbError(error); }
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      await client.query("SELECT set_config('app.agent_id', $1, true)", [agentId]);
      const result = await operation(client);
      await client.query("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try { await client.query("ROLLBACK"); } catch { /* original failure preserved */ }
      }
      throw dbError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
