import { Pool, type PoolClient, type PoolConfig } from "pg";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "./scope-schema.ts";

export interface PostgresScopeClaims {
  readonly tenantId: string;
  readonly projectId: string;
  readonly policyEpoch: number;
}

export function createPostgresPool(connectionString: string, options: Omit<PoolConfig, "connectionString"> = {}): Pool {
  return new Pool({ ...options, connectionString });
}

/**
 * Run one async driver transaction. Scope claims are transaction-local, so commit/rollback clears them
 * before the checked-out connection returns to the pool.
 */
export async function withPostgresTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  claims?: PostgresScopeClaims,
): Promise<T> {
  const client = await pool.connect();
  let released = false,
    connectionError: Error | undefined;
  // The pool removes its idle error listener while a client is checked out. A disconnect can
  // reject the query AND emit a client error before rollback/release has returned it to the pool.
  const onConnectionError = (error: Error) => {
    connectionError ??= error;
  };
  client.on("error", onConnectionError);
  try {
    await client.query("BEGIN");
    if (claims) {
      assertClaims(claims);
      const names = POSTGRES_SCOPE_SCHEMA_CONTRACT.claims;
      await client.query("SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)", [
        names.tenantId,
        claims.tenantId,
        names.projectId,
        claims.projectId,
        names.policyEpoch,
        String(claims.policyEpoch),
      ]);
    }
    const result = await operation(client);
    if (connectionError) throw connectionError;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
      released = true;
      throw new AggregateError(
        [error, ...(connectionError && connectionError !== error ? [connectionError] : []), rollbackError],
        "PostgreSQL transaction and rollback both failed.",
      );
    }
    throw error;
  } finally {
    if (!released) client.release();
    client.removeListener("error", onConnectionError);
  }
}

function assertClaims(claims: PostgresScopeClaims): void {
  if (!claims.tenantId || !claims.projectId || !Number.isSafeInteger(claims.policyEpoch) || claims.policyEpoch < 0)
    throw new TypeError("PostgreSQL scope claims require tenant, project, and a non-negative safe policy epoch.");
}
