import {
  makeSqliteTaskEventStore,
  type SqliteCanonicalEventStore,
  type SqliteTaskEventStoreOptions,
} from "./sqlite-task-event-store.ts";
import { activateEmptyCanonicalGeneration, resolveActiveGeneration } from "./sqlite-event-store.ts";
import { resolveStorageBackend, unsupportedStorageBackendError } from "../storage-backend.ts";
import type { LedgerEventStorePort as KernelLedgerEventStorePort } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { PostgresStorageBackendConfig } from "../storage-backend.ts";

// Ordinary attachment cannot bypass activation with an explicit old generation.
// Offline conversion opens its source through the read-only SQLite storage port.
const selectGeneration = (options: SqliteTaskEventStoreOptions): SqliteTaskEventStoreOptions => {
  const rootInput = options.rootInput ?? options.rootDir;
  if (options.generation !== undefined && options.generation !== 3)
    throw new Error("ordinary readers and writers require generation 3; old generations are offline inputs");
  if (rootInput === undefined) return options;
  return { ...options, generation: resolveActiveGeneration({ rootInput, repoId: options.repoId }) };
};

type TaskEventStoreFactoryOptions = SqliteTaskEventStoreOptions | PostgresTaskEventStoreOptions;

export type PostgresTaskEventStoreOptions = Omit<SqliteTaskEventStoreOptions, "storage"> & {
  readonly storage: PostgresStorageBackendConfig;
};

function selectBackend(options: TaskEventStoreFactoryOptions): asserts options is SqliteTaskEventStoreOptions {
  const backend = resolveStorageBackend(options);
  if (backend.backend === "postgres") throw unsupportedStorageBackendError(backend.backend);
}

export function makeTaskEventStore(options: PostgresTaskEventStoreOptions): KernelLedgerEventStorePort;
export function makeTaskEventStore(options: SqliteTaskEventStoreOptions): SqliteCanonicalEventStore;
export function makeTaskEventStore(
  options: TaskEventStoreFactoryOptions,
): SqliteCanonicalEventStore | KernelLedgerEventStorePort {
  selectBackend(options);
  const selected = selectGeneration(options);
  return makeSqliteTaskEventStore({
    ...selected,
    ...(options.activationPreflight === undefined && selected.generation === 3
      ? { activationPreflight: activateEmptyCanonicalGeneration }
      : {}),
  });
}
export function makeTaskEventReader(options: PostgresTaskEventStoreOptions): KernelLedgerEventStorePort;
export function makeTaskEventReader(options: SqliteTaskEventStoreOptions): SqliteCanonicalEventStore;
export function makeTaskEventReader(
  options: TaskEventStoreFactoryOptions,
): SqliteCanonicalEventStore | KernelLedgerEventStorePort {
  selectBackend(options);
  return makeSqliteTaskEventStore({ ...selectGeneration(options), mutable: false });
}
export type { SqliteCanonicalEventStore, SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";
export type { LedgerEventStorePort } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
export type {
  PostgresStorageBackendConfig,
  ResolvedStorageBackend,
  SqliteStorageBackendConfig,
  StorageBackend,
  StorageBackendConfig,
  StorageBackendOptions,
  StorageScope,
} from "../storage-backend.ts";
export { readCertifiedGitFollower, type CertifiedGitFollower } from "./sqlite-task-event-publication.ts";
