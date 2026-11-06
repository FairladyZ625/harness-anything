import { initializePGliteReadSchema, backfillPGliteIndexPage } from "./read-index-schema.ts";
import { backfillPgReadIndexPage } from "../pg/pg-read-index-backfill.ts";
import type { PgProjectionScope } from "../pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import type { PostgresAppendHooks } from "../postgres/pg-event-store.ts";
import { backfillPgArtifactDocuments } from "../pg/pg-artifact-timeline.ts";
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
  readonly backfillReadIndexes: (
    scope?: PgProjectionScope,
    repoId?: string,
  ) => Promise<{ processed: number; done: boolean }>;
}

/** Open the shared PostgreSQL ledger/projection adapters on PGlite's one-connection driver. */
export async function createPGliteStorageBackend(options: PGliteStorageBackendOptions): Promise<PGliteStorageBackend> {
  const scope = resolvePostgresEventStoreScope(options.storage.scope),
    storage = createPGliteStorage({ dataDir: options.storage.dataDir, pglite: options.pglite });
  try {
    await withPostgresTransaction(storage.pool, async (client) => {
      await initializePGliteReadSchema(client);
    });
    // An empty repo has no historical summaries to migrate. Certify only that
    // bounded case here; nonempty upgrades publish readiness on their background zero page.
    await withPostgresTransaction(
      storage.pool,
      (client) =>
        client.query(
          `INSERT INTO ha_event_summary_state(tenant_id,project_id,policy_epoch,repo_id,ready)
        SELECT $1,$2,$3,$4,true WHERE NOT EXISTS (
          SELECT 1 FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$4 LIMIT 1)
        ON CONFLICT (tenant_id,project_id,policy_epoch,repo_id) DO NOTHING`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, options.repoId],
        ),
      scope,
    );
    await withPostgresTransaction(
      storage.pool,
      (client) => backfillPgArtifactDocuments(client, scope, options.repoId),
      scope,
    );
    return {
      ...createPgStorageBackend({
        pool: storage.pool,
        repoId: options.repoId,
        scope,
        readAuthoredDocument: options.readAuthoredDocument,
      }),
      backfillReadIndexes: async (claims = scope, repoId = options.repoId) => {
        const page = await withPostgresTransaction(storage.pool, backfillPGliteIndexPage);
        return page.done ? backfillPgReadIndexPage(storage.pool, claims, repoId) : page;
      },
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
