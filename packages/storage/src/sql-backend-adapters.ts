import type { LedgerEventStorePort, TaskProjectionPort, TaskProjectionReaderPort } from "@harness-anything/kernel";
import type { PgQueryConnectionOptions, PgTaskQueryReader } from "./pg/pg-task-query-reader.ts";
import type { PGliteStorageBackendConfig, PostgresStorageBackendConfig } from "./storage-backend.ts";
import type { PersistentWriterEpoch } from "./writer-epoch-contract.ts";
import type {
  PGliteTaskProjectionFactoryOptions,
  PostgresTaskProjectionFactoryOptions,
} from "./projection/rebuildable-task-projection-factory.ts";

export type SqlTaskQueryReaderOpener = (
  options: Omit<PgQueryConnectionOptions, "scope"> & {
    readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
    readonly requireRuntimeRole?: boolean;
    readonly epochAuthority?: boolean;
  },
) => PgTaskQueryReader;

export type ExternalWriterEpochOpener = (options: {
  readonly stateRoot: string;
  readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
  readonly holderId?: string;
  readonly now?: () => string;
}) => PersistentWriterEpoch;

export type ExternalTaskProjectionFactory = (
  options: PostgresTaskProjectionFactoryOptions | PGliteTaskProjectionFactoryOptions,
) => TaskProjectionPort;

export interface SqlBackendAdapters {
  readonly createSqlTaskQueryReader?: SqlTaskQueryReaderOpener;
  readonly openPgWriterEpoch?: ExternalWriterEpochOpener;
  readonly makePgTaskProjection?: ExternalTaskProjectionFactory;
  readonly pgliteWorkerContext?: {
    readonly prepare: (
      repoId: string,
      storage: PGliteStorageBackendConfig,
    ) => {
      readonly context: import("./pglite/query-owner.ts").PGliteWorkerContext;
      readonly transferList: import("node:worker_threads").MessagePort[];
      readonly close: () => void;
    };
    readonly install: (context: import("./pglite/query-owner.ts").PGliteWorkerContext) => void;
  };
}

type RegisteredAdapters = {
  createSqlTaskQueryReader?: SqlTaskQueryReaderOpener;
  openPgWriterEpoch?: ExternalWriterEpochOpener;
  makePgTaskProjection?: ExternalTaskProjectionFactory;
  pgliteWorkerContext?: SqlBackendAdapters["pgliteWorkerContext"];
};
const adapters: Record<"postgres" | "pglite", RegisteredAdapters> = { postgres: {}, pglite: {} };

/** Register PostgreSQL or PGlite runtime adapters without coupling SQLite entrypoints to external drivers. */
export function registerSqlBackendAdapters(next: SqlBackendAdapters, backend?: "postgres" | "pglite"): void {
  const backends: readonly ("postgres" | "pglite")[] = backend ? [backend] : ["postgres", "pglite"];
  for (const selected of backends) {
    const target = adapters[selected];
    if (next.createSqlTaskQueryReader) target.createSqlTaskQueryReader = next.createSqlTaskQueryReader;
    if (next.openPgWriterEpoch) target.openPgWriterEpoch = next.openPgWriterEpoch;
    if (next.makePgTaskProjection) target.makePgTaskProjection = next.makePgTaskProjection;
    if (next.pgliteWorkerContext) target.pgliteWorkerContext = next.pgliteWorkerContext;
  }
}

export function requirePgliteWorkerContextHandler(): NonNullable<SqlBackendAdapters["pgliteWorkerContext"]> {
  if (!adapters.pglite.pgliteWorkerContext) {
    throw new Error(
      'PGlite worker context handler is not registered; import "@harness-anything/storage" or "@harness-anything/storage/pglite"',
    );
  }
  return adapters.pglite.pgliteWorkerContext;
}

export function requireSqlTaskQueryReader(backend: "postgres" | "pglite"): SqlTaskQueryReaderOpener {
  if (!adapters[backend].createSqlTaskQueryReader) {
    throw new Error(
      `SQL query reader for "${backend}" is not registered; import "@harness-anything/storage" or "@harness-anything/storage/${backend === "postgres" ? "pg" : "pglite"}"`,
    );
  }
  return adapters[backend].createSqlTaskQueryReader;
}

export function requireExternalWriterEpochOpener(backend: "postgres" | "pglite"): ExternalWriterEpochOpener {
  if (!adapters[backend].openPgWriterEpoch) {
    throw new Error(
      `Writer epoch authority for "${backend}" is not registered; import "@harness-anything/storage" or "@harness-anything/storage/${backend === "postgres" ? "pg" : "pglite"}"`,
    );
  }
  return adapters[backend].openPgWriterEpoch;
}

export function requireExternalTaskProjectionFactory(backend: "postgres" | "pglite"): ExternalTaskProjectionFactory {
  if (!adapters[backend].makePgTaskProjection) {
    throw new Error(
      `Task projection factory for "${backend}" is not registered; import "@harness-anything/storage" or "@harness-anything/storage/${backend === "postgres" ? "pg" : "pglite"}"`,
    );
  }
  return adapters[backend].makePgTaskProjection;
}

export type { LedgerEventStorePort, TaskProjectionReaderPort };
