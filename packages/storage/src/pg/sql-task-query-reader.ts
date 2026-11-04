import type { PGliteStorageBackendConfig, PostgresStorageBackendConfig } from "../storage-backend.ts";
import { createPGliteTaskQueryReader } from "../pglite/query-owner.ts";
import { resolvePostgresEventStoreScope } from "./backend.ts";
import { createPgTaskQueryReader, type PgQueryConnectionOptions } from "./pg-task-query-reader.ts";

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
