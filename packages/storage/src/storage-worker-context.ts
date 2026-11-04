import type { PGliteStorageBackendConfig, StorageBackendConfig } from "./storage-backend.ts";
import {
  preparePGliteWorkerContext,
  installPGliteWorkerContext,
  type PGliteWorkerContext,
} from "./pglite/query-owner.ts";

export type StorageWorkerContext = PGliteWorkerContext;

/** Transferred physical capabilities cannot be rebound by changing a query's JSON config. */
export function requiresStorageWorkerContext(
  storage: StorageBackendConfig | undefined,
): storage is PGliteStorageBackendConfig {
  return storage?.backend === "pglite";
}

/** Physical storage capabilities cross worker boundaries separately from public JSON config. */
export function prepareStorageWorkerContext(storage: StorageBackendConfig | undefined, repoId: string) {
  return requiresStorageWorkerContext(storage)
    ? preparePGliteWorkerContext(repoId, storage)
    : { context: undefined, transferList: [], close: () => undefined };
}

export function installStorageWorkerContext(context: StorageWorkerContext | undefined): void {
  if (context) installPGliteWorkerContext(context);
}
