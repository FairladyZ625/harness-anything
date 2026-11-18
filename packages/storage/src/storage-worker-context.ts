import type { PGliteStorageBackendConfig, StorageBackendConfig } from "./storage-backend.ts";
import { requirePgliteWorkerContextHandler } from "./sql-backend-adapters.ts";

export type StorageWorkerContext = import("./pglite/query-owner.ts").PGliteWorkerContext;

/** Transferred physical capabilities cannot be rebound by changing a query's JSON config. */
export function requiresStorageWorkerContext(
  storage: StorageBackendConfig | undefined,
): storage is PGliteStorageBackendConfig {
  return storage?.backend === "pglite";
}

/** Physical storage capabilities cross worker boundaries separately from public JSON config. */
export function prepareStorageWorkerContext(
  storage: StorageBackendConfig | undefined,
  repoId: string,
): {
  readonly context: StorageWorkerContext | undefined;
  readonly transferList: import("node:worker_threads").MessagePort[];
  readonly close: () => void;
} {
  return requiresStorageWorkerContext(storage)
    ? requirePgliteWorkerContextHandler().prepare(repoId, storage)
    : { context: undefined, transferList: [], close: () => undefined };
}

export function installStorageWorkerContext(context: StorageWorkerContext | undefined): void {
  if (context) requirePgliteWorkerContextHandler().install(context);
}
