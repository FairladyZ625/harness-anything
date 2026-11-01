import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { createPgConfig } from "@electric-sql/pglite/node-postgres";
import { Pool, type PoolConfig } from "pg";

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
