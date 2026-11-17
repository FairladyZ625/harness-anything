import type { PGliteStorageBackendConfig, PostgresStorageBackendConfig } from "../storage-backend.ts";
import {
  createPGliteTaskQueryReader,
  installPGliteWorkerContext,
  preparePGliteWorkerContext,
} from "../pglite/query-owner.ts";
import { resolvePostgresEventStoreScope } from "./backend.ts";
import { createPgTaskQueryReader, type PgQueryConnectionOptions } from "./pg-task-query-reader.ts";
import { makePgTaskProjection } from "./pg-task-projection.ts";
import { openPgWriterEpoch } from "../postgres/pg-writer-epoch.ts";
import { registerSqlBackendAdapters } from "../sql-backend-adapters.ts";

registerSqlBackendAdapters({
  createSqlTaskQueryReader,
  openPgWriterEpoch,
  makePgTaskProjection,
  pgliteWorkerContext: {
    prepare: preparePGliteWorkerContext,
    install: installPGliteWorkerContext,
  },
});

/** Select the physical owner once; callers retain the same synchronous query port. */
export function createSqlTaskQueryReader(
  options: Omit<PgQueryConnectionOptions, "scope"> & {
    readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
    readonly requireRuntimeRole?: boolean;
    readonly epochAuthority?: boolean;
  },
) {
  const { storage, requireRuntimeRole, epochAuthority, ...connection } = options,
    common = { ...connection, scope: resolvePostgresEventStoreScope(storage.scope) };
  return storage.backend === "pglite"
    ? createPGliteTaskQueryReader({ ...common, storage })
    : createPgTaskQueryReader({
        ...common,
        connectionString: storage.connectionString,
        authorityConnectionString: epochAuthority ? storage.authorityConnectionString : undefined,
        requireRuntimeRole,
      });
}
