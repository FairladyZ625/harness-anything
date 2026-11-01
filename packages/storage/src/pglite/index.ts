import { createPgStorageBackend, resolvePostgresEventStoreScope, type PgStorageBackend } from "../pg/backend.ts";
import { createPostgresPool } from "../postgres/transaction.ts";
import type { PostgresAppendHooks } from "../postgres/pg-event-store.ts";
import type { PGliteStorageBackendConfig, PostgresStorageBackendConfig } from "../storage-backend.ts";
import { createPGliteStorageBackend } from "./storage-backend.ts";

export interface PgDialectStorageBackend extends PgStorageBackend {
  readonly close: () => Promise<void>;
}

export type PgDialectStorageBackendConfig = PostgresStorageBackendConfig | PGliteStorageBackendConfig;

/** Open PostgreSQL or PGlite through the same ledger, projection, and entity ports. */
export async function createPgDialectStorageBackend(input: {
  readonly repoId: string;
  readonly storage: PgDialectStorageBackendConfig;
  readonly readAuthoredDocument?: PostgresAppendHooks["readAuthoredDocument"];
}): Promise<PgDialectStorageBackend> {
  if (input.storage.backend === "pglite") {
    const backend = await createPGliteStorageBackend({
      repoId: input.repoId,
      storage: input.storage,
      readAuthoredDocument: input.readAuthoredDocument,
    });
    return {
      eventStore: backend.eventStore,
      projection: backend.projection,
      entities: backend.entities,
      close: backend.close,
    };
  }

  const scope = resolvePostgresEventStoreScope(input.storage.scope),
    pool = createPostgresPool(input.storage.connectionString);
  try {
    return {
      ...createPgStorageBackend({
        pool,
        repoId: input.repoId,
        scope,
        readAuthoredDocument: input.readAuthoredDocument,
      }),
      close: () => pool.end(),
    };
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "PostgreSQL storage initialization and close both failed.");
    }
    throw error;
  }
}

export { createPGliteStorage, type PGliteStorage, type PGliteStorageOptions } from "./transaction.ts";
export { createPGliteStorageBackend } from "./storage-backend.ts";
export type { PGliteStorageBackend, PGliteStorageBackendOptions } from "./storage-backend.ts";
