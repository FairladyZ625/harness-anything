import type { PoolClient } from "pg";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS, POSTGRES_EVENT_LEDGER_TABLES } from "../postgres/index.ts";
import type { PostgresAppendHooks } from "../postgres/pg-event-store.ts";
import { backfillPgDecisionSearchPage } from "../pg/pg-decision-search.ts";
import { ensurePgProjectionSchema } from "../pg/pg-projection-schema.ts";
import { createPgStorageBackend, resolvePostgresEventStoreScope, type PgStorageBackend } from "../pg/backend.ts";
import type { PGliteStorageBackendConfig } from "../storage-backend.ts";
import { createPGliteStorage, type PGliteStorage, type PGliteStorageOptions } from "./transaction.ts";

export interface PGliteStorageBackendOptions extends Omit<PGliteStorageOptions, "dataDir"> {
  readonly repoId: string;
  readonly storage: PGliteStorageBackendConfig;
  readonly readAuthoredDocument?: PostgresAppendHooks["readAuthoredDocument"];
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
    await initializeSchema(storage.pool, scope, options.repoId);
    return {
      ...createPgStorageBackend({
        pool: storage.pool,
        repoId: options.repoId,
        scope,
        readAuthoredDocument: options.readAuthoredDocument,
      }),
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

async function initializeSchema(
  pool: PGliteStorage["pool"],
  scope: PostgresScopeClaims,
  repoId: string,
): Promise<void> {
  await withPostgresTransaction(pool, async (client) => {
    for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) {
      if (statement.startsWith("CREATE POLICY ")) await ensurePolicy(client, statement, POSTGRES_EVENT_LEDGER_TABLES);
      else await client.query(statement);
    }
    await ensurePgProjectionSchema(client, { indexBuild: "isolated" });
  });
  for (;;) {
    const processed = await withPostgresTransaction(
      pool,
      async (client) =>
        (
          await client.query<{ processed: number }>("SELECT ha_backfill_decision_indexes($1,$2,$3) AS processed", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
          ])
        ).rows[0]!.processed,
      scope,
    );
    if (processed === 0) break;
  }
  for (;;) {
    const processed = await withPostgresTransaction(
      pool,
      (client) => backfillPgDecisionSearchPage(client, scope),
      scope,
    );
    if (processed === 0) break;
  }
  // Commit each bounded expansion page before admitting readers of this embedded scope.
  for (;;) {
    const processed = await withPostgresTransaction(
      pool,
      async (client) =>
        (
          await client.query<{ processed: number }>(
            "SELECT ha_backfill_projection_read_indexes($1,$2,$3) AS processed",
            [scope.tenantId, scope.projectId, scope.policyEpoch],
          )
        ).rows[0]!.processed,
      scope,
    );
    if (processed === 0) break;
  }
  for (;;) {
    const processed = await withPostgresTransaction(
      pool,
      async (client) =>
        (
          await client.query<{ processed: number }>("SELECT ha_backfill_event_read_indexes($1,$2,$3,$4) AS processed", [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
            repoId,
          ])
        ).rows[0]!.processed,
      scope,
    );
    if (processed === 0) break;
  }
  // Embedded storage owns its schema: finish the dated v5 expansion before exposing this scope.
  // Each committed primary-key page advances; processed=0, rather than the cursor, ends the scan.
  let owner = "",
    entity = "";
  for (;;) {
    const batch = await withPostgresTransaction(
      pool,
      async (client) =>
        (
          await client.query<{ processed: number; next_owner: string; next_entity: string }>(
            "SELECT * FROM ha_backfill_document_metadata($1,$2,$3,$4,$5)",
            [scope.tenantId, scope.projectId, scope.policyEpoch, owner, entity],
          )
        ).rows[0]!,
      scope,
    );
    if (batch.processed === 0) break;
    owner = batch.next_owner;
    entity = batch.next_entity;
  }
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
