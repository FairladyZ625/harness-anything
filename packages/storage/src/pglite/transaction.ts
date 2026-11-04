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
  assertPGliteRuntime();
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

export function assertPGliteRuntime(): void {
  // Node 24's V8 can abort the host process while reclaiming WASM import wrappers.
  // Keep this check before construction: a native CHECK cannot become a JS rejection.
  // https://github.com/nodejs/node/issues/66366
  if (Number(process.versions.node.split(".")[0]) < 26) {
    throw Object.assign(
      new Error(
        `PGlite requires Node.js 26 or newer; current Node.js is ${process.versions.node}. SQLite and external PostgreSQL support Node.js 24.`,
      ),
      { code: "pglite_runtime_unsupported" },
    );
  }
}
