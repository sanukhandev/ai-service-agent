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

  constructor(databaseUrl: string, config: Pick<PoolConfig, "max" | "idleTimeoutMillis" | "connectionTimeoutMillis"> = {}) {
    if (!databaseUrl || !databaseUrl.trim()) {
      throw new PersistenceError("NOT_CONFIGURED", "DATABASE_URL must be provided");
    }
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    });
  }

  // Invoke at API startup. A migration superuser MUST NOT be used for requests.
  async assertSafeRuntimeRole(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; member: boolean }>(
        "SELECT r.rolsuper, r.rolbypassrls, pg_has_role(current_user, 'ai_service_runtime', 'member') AS member FROM pg_roles r WHERE r.rolname = current_user",
      );
      const row = result.rows[0];
      if (!row || row.rolsuper || row.rolbypassrls || !row.member) {
        throw new PersistenceError("NOT_CONFIGURED", "Application login must inherit ai_service_runtime and must not bypass RLS");
      }
    } finally {
      client.release();
    }
  }

  async withAgent<T>(agentId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    requireUuid(agentId, "agentId");
    const client = await this.pool.connect();
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
