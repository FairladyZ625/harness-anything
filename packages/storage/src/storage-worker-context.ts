import type { StorageBackendConfig } from "./storage-backend.ts";
import {
  preparePGliteWorkerContext,
  installPGliteWorkerContext,
  type PGliteWorkerContext,
} from "./pglite/query-owner.ts";

export type StorageWorkerContext = PGliteWorkerContext;

/** Physical storage capabilities cross worker boundaries separately from public JSON config. */
export function prepareStorageWorkerContext(storage: StorageBackendConfig | undefined, repoId: string) {
  return storage?.backend === "pglite"
    ? preparePGliteWorkerContext(repoId, storage)
    : { context: undefined, transferList: [], close: () => undefined };
}

export function installStorageWorkerContext(context: StorageWorkerContext | undefined): void {
  if (context) installPGliteWorkerContext(context);
}
