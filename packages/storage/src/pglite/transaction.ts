import { PGlite, type PGliteOptions, type Results, type Transaction } from "@electric-sql/pglite";
import { createPgConfig } from "@electric-sql/pglite/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../postgres/scope-schema.ts";
import type { PostgresScopeClaims } from "../postgres/transaction.ts";

export type { PostgresScopeClaims } from "../postgres/transaction.ts";

export interface PGliteStorage {
  readonly db: PGlite;
  readonly pool: Pool;
  /** Closes the node-postgres adapter and then the owned PGlite instance. */
  readonly close: () => Promise<void>;
}

export interface PGliteStorageOptions {
  readonly dataDir?: string;
  readonly pglite?: PGliteOptions;
}

export interface PGlitePool extends Pool {
  readonly pglite: PGlite;
  readonly closePGlite: () => Promise<void>;
}

/**
 * Create the single PGlite connection used by the local backend.
 *
 * PGlite owns one PostgreSQL session. The node-postgres adapter is deliberately configured with
 * its native poolSize=1 rather than presenting a fake multi-connection pool to callers.
 */
export function createPGliteStorage(options: PGliteStorageOptions = {}): PGliteStorage {
  const db = options.dataDir === undefined ? new PGlite(options.pglite) : new PGlite(options.dataDir, options.pglite);
  const pool = new Pool({ ...(createPgConfig(db) as unknown as PoolConfig), max: 1 });
  let closed = false;
  return {
    db,
    pool,
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
      if (!db.closed) await db.close();
    },
  };
}

/** Create the node-postgres-compatible single-connection adapter. */
export function createPGlitePool(options: PGliteStorageOptions = {}): PGlitePool {
  const storage = createPGliteStorage(options),
    pool = storage.pool as PGlitePool;
  Object.defineProperties(pool, {
    pglite: { configurable: false, enumerable: false, value: storage.db },
    closePGlite: { configurable: false, enumerable: false, value: storage.close },
  });
  return pool;
}

/**
 * Run one transaction directly on PGlite. Claims are transaction-local and disappear on both
 * commit and rollback, matching the PostgreSQL pool bridge.
 */
export function withPGliteTransaction<T>(
  db: PGlite,
  operation: (transaction: Transaction) => Promise<T>,
  claims?: PostgresScopeClaims,
): Promise<T>;

/**
 * Run a transaction through the node-postgres adapter. This overload is useful while the PG and
 * PGlite storage implementations share the same query port.
 */
export function withPGliteTransaction<T>(
  pool: PGlitePool,
  operation: (client: PoolClient) => Promise<T>,
  claims?: PostgresScopeClaims,
): Promise<T>;
export async function withPGliteTransaction<T>(
  target: PGlite | PGlitePool,
  operation: ((transaction: Transaction) => Promise<T>) | ((client: PoolClient) => Promise<T>),
  claims?: PostgresScopeClaims,
): Promise<T> {
  if (isPGlitePool(target)) {
    const client = await target.connect();
    let released = false;
    try {
      await client.query("BEGIN");
      if (claims) {
        assertClaims(claims);
        await setClaims(client as unknown as QueryTarget, claims);
      }
      const result = await (operation as (client: PoolClient) => Promise<T>)(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
        released = true;
        throw new AggregateError([error, rollbackError], "PGlite transaction and rollback both failed.");
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }
  if (claims) assertClaims(claims);
  return target.transaction(async (transaction) => {
    if (claims) await setClaims(transaction as unknown as QueryTarget, claims);
    return (operation as (transaction: Transaction) => Promise<T>)(transaction);
  });
}

function isPGlitePool(target: PGlite | PGlitePool): target is PGlitePool {
  return "pglite" in target;
}

interface QueryTarget {
  query: (query: string, params?: any[]) => Promise<unknown>;
}

async function setClaims(target: QueryTarget, claims: PostgresScopeClaims): Promise<void> {
  const names = POSTGRES_SCOPE_SCHEMA_CONTRACT.claims;
  await target.query("SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true)", [
    names.tenantId,
    claims.tenantId,
    names.projectId,
    claims.projectId,
    names.policyEpoch,
    String(claims.policyEpoch),
  ]);
}

function assertClaims(claims: PostgresScopeClaims): void {
  if (!claims.tenantId || !claims.projectId || !Number.isSafeInteger(claims.policyEpoch) || claims.policyEpoch < 0)
    throw new TypeError("PGlite scope claims require tenant, project, and a non-negative safe policy epoch.");
}

export type PGliteQueryResult<T> = Results<T>;
