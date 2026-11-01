import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS, POSTGRES_EVENT_LEDGER_TABLES } from "../postgres/index.ts";
import { ensurePgProjectionSchema } from "../pg/pg-projection-schema.ts";
import { createPgStorageBackend, resolvePostgresEventStoreScope, type PgStorageBackend } from "../pg/backend.ts";
import type { PGliteStorageBackendConfig } from "../storage-backend.ts";
import { createPGliteStorage, type PGliteStorage, type PGliteStorageOptions } from "./transaction.ts";

export interface PGliteStorageBackendOptions extends Omit<PGliteStorageOptions, "dataDir"> {
  readonly repoId: string;
  readonly storage: PGliteStorageBackendConfig;
}

export interface PGliteStorageBackend extends PgStorageBackend {
  readonly db: PGliteStorage["db"];
  readonly pool: PGliteStorage["pool"];
  readonly close: PGliteStorage["close"];
}

/** Open the shared PostgreSQL ledger/projection adapters on PGlite's one-connection driver. */
export async function createPGliteStorageBackend(options: PGliteStorageBackendOptions): Promise<PGliteStorageBackend> {
  const scope = resolvePostgresEventStoreScope(options.storage.scope),
    storage = createPGliteStorage({ dataDir: options.storage.dataDir, pglite: options.pglite });
  try {
    await initializeSchema(storage.pool);
    return {
      ...createPgStorageBackend({ pool: storage.pool, repoId: options.repoId, scope }),
      db: storage.db,
      pool: storage.pool,
      close: storage.close,
    };
  } catch (error) {
    try {
      await storage.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "PGlite storage initialization and close both failed.");
    }
    throw error;
  }
}

async function initializeSchema(pool: PGliteStorage["pool"]): Promise<void> {
  await withPostgresTransaction(pool, async (client) => {
    for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) {
      if (statement.startsWith("CREATE POLICY ")) await ensurePolicy(client, statement, POSTGRES_EVENT_LEDGER_TABLES);
      else await client.query(statement);
    }
    await ensurePgProjectionSchema(client);
  });
}

async function ensurePolicy(client: PoolClient, statement: string, tables: readonly string[]): Promise<void> {
  const match = /^CREATE POLICY "([a-z0-9_]+)" ON "([a-z0-9_]+)"/u.exec(statement);
  if (!match) throw new Error("unexpected PostgreSQL scope policy statement");
  const [, policy, table] = match;
  if (!tables.includes(table!)) throw new Error(`unexpected PostgreSQL scope policy table: ${table}`);
  await client.query(
    `DO $policy$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = '${table}' AND policyname = '${policy}') THEN
         EXECUTE $policy_sql$${statement}$policy_sql$;
       END IF;
     END $policy$`,
  );
}
