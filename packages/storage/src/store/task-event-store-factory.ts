import {
  makeSqliteTaskEventStore,
  type SqliteCanonicalEventStore,
  type SqliteTaskEventStoreOptions,
} from "./sqlite-task-event-store.ts";
import { activateEmptyCanonicalGeneration, resolveActiveGeneration } from "./sqlite-event-store.ts";
import { resolveStorageBackend, unsupportedStorageBackendError } from "../storage-backend.ts";
import type { LedgerEventStorePort as KernelLedgerEventStorePort } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { PostgresStorageBackendConfig, PGliteStorageBackendConfig } from "../storage-backend.ts";
import { makePgCanonicalEventStore } from "../postgres/pg-canonical-event-store.ts";
import { attachSqliteGitFollower } from "./sqlite-git-outbox-publisher.ts";
import { attachPgGitFollower } from "../pg/pg-git-outbox-publisher.ts";
import { createSqlTaskQueryReader } from "../pg/sql-task-query-reader.ts";

// Ordinary attachment cannot bypass activation with an explicit old generation.
// Offline conversion opens its source through the read-only SQLite storage port.
const selectGeneration = (options: SqliteTaskEventStoreOptions): SqliteTaskEventStoreOptions => {
  const rootInput = options.rootInput ?? options.rootDir;
  if (options.generation !== undefined && options.generation !== 3)
    throw new Error("ordinary readers and writers require generation 3; old generations are offline inputs");
  if (rootInput === undefined) return options;
  return { ...options, generation: resolveActiveGeneration({ rootInput, repoId: options.repoId }) };
};

export type PostgresTaskEventStoreOptions = Omit<SqliteTaskEventStoreOptions, "storage" | "attachGitFollower"> & {
  readonly storage: PostgresStorageBackendConfig;
};
export type PGliteTaskEventStoreOptions = Omit<SqliteTaskEventStoreOptions, "storage" | "attachGitFollower"> & {
  readonly storage: PGliteStorageBackendConfig;
};
type TaskEventStoreFactoryOptions = Omit<SqliteTaskEventStoreOptions, "storage" | "attachGitFollower"> & {
  readonly storage?: SqliteTaskEventStoreOptions["storage"] | PostgresStorageBackendConfig | PGliteStorageBackendConfig;
  readonly attachGitFollower?: SqliteTaskEventStoreOptions["attachGitFollower"];
};
type RuntimeCanonicalEventStore = KernelLedgerEventStorePort & {
  readonly pruneReplicationLog?: (beforeSequence: number) => void;
};

function selectBackend(options: TaskEventStoreFactoryOptions): asserts options is SqliteTaskEventStoreOptions {
  const backend = resolveStorageBackend(options);
  if (backend.backend !== "sqlite") throw unsupportedStorageBackendError(backend.backend);
}

export function makeTaskEventStore(options: PostgresTaskEventStoreOptions): KernelLedgerEventStorePort;
export function makeTaskEventStore(options: PGliteTaskEventStoreOptions): KernelLedgerEventStorePort;
export function makeTaskEventStore(options: SqliteTaskEventStoreOptions): SqliteCanonicalEventStore;
export function makeTaskEventStore(options: TaskEventStoreFactoryOptions): RuntimeCanonicalEventStore;
export function makeTaskEventStore(
  options: TaskEventStoreFactoryOptions,
): SqliteCanonicalEventStore | KernelLedgerEventStorePort {
  if (options.storage?.backend === "postgres" || options.storage?.backend === "pglite")
    return makePgCanonicalEventStore({
      ...(options as PostgresTaskEventStoreOptions | PGliteTaskEventStoreOptions),
      createReader: createSqlTaskQueryReader,
      attachGitFollower: attachPgGitFollower,
    } as Parameters<typeof makePgCanonicalEventStore>[0]);
  selectBackend(options);
  const selected = selectGeneration(options);
  return makeSqliteTaskEventStore({
    ...selected,
    attachGitFollower: selected.attachGitFollower ?? attachSqliteGitFollower,
    ...(options.activationPreflight === undefined && selected.generation === 3
      ? { activationPreflight: activateEmptyCanonicalGeneration }
      : {}),
  });
}
export function makeTaskEventReader(options: PostgresTaskEventStoreOptions): KernelLedgerEventStorePort;
export function makeTaskEventReader(options: PGliteTaskEventStoreOptions): KernelLedgerEventStorePort;
export function makeTaskEventReader(options: SqliteTaskEventStoreOptions): SqliteCanonicalEventStore;
export function makeTaskEventReader(options: TaskEventStoreFactoryOptions): RuntimeCanonicalEventStore;
export function makeTaskEventReader(
  options: TaskEventStoreFactoryOptions,
): SqliteCanonicalEventStore | KernelLedgerEventStorePort {
  if (options.storage?.backend === "postgres" || options.storage?.backend === "pglite")
    return makePgCanonicalEventStore({
      ...(options as PostgresTaskEventStoreOptions | PGliteTaskEventStoreOptions),
      mutable: false,
      createReader: createSqlTaskQueryReader,
    } as Parameters<typeof makePgCanonicalEventStore>[0]);
  selectBackend(options);
  return makeSqliteTaskEventStore({ ...selectGeneration(options), mutable: false });
}
export type { SqliteCanonicalEventStore, SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";
export type { LedgerEventStorePort } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
export type {
  PGliteStorageBackendConfig,
  PostgresStorageBackendConfig,
  ResolvedStorageBackend,
  SqliteStorageBackendConfig,
  StorageBackend,
  StorageBackendConfig,
  StorageBackendOptions,
  StorageScope,
} from "../storage-backend.ts";
export { readCertifiedGitFollower, type CertifiedGitFollower } from "./sqlite-task-event-publication.ts";
