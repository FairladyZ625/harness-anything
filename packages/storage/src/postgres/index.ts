// Driver-pure PostgreSQL subpath entrypoint: zero @electric-sql/pglite, zero Git/child_process.
import { createPgTaskQueryReader } from "../pg/pg-task-query-reader.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import { makePgTaskProjection } from "../pg/pg-task-projection.ts";
import { registerSqlBackendAdapters } from "../sql-backend-adapters.ts";
import { openPgWriterEpoch } from "./pg-writer-epoch.ts";

registerSqlBackendAdapters(
  {
    createSqlTaskQueryReader: (options) => {
      if (options.storage.backend !== "postgres") {
        throw new Error("@harness-anything/storage/pg does not support non-postgres SQL backends");
      }
      const { storage, requireRuntimeRole, epochAuthority, ...connection } = options;
      return createPgTaskQueryReader({
        ...connection,
        scope: resolvePostgresEventStoreScope(storage.scope),
        connectionString: storage.connectionString,
        authorityConnectionString: epochAuthority ? storage.authorityConnectionString : undefined,
        requireRuntimeRole,
      });
    },
    openPgWriterEpoch,
    makePgTaskProjection,
  },
  "postgres",
);

export {
  POSTGRES_SCOPE_COLUMNS_SQL,
  POSTGRES_SCOPE_SCHEMA_CONTRACT,
  postgresScopeRlsStatements,
} from "./scope-schema.ts";
export type { PostgresScopeClaims } from "./transaction.ts";
export { createPostgresPool, withPostgresTransaction } from "./transaction.ts";
export { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS, POSTGRES_EVENT_LEDGER_TABLES } from "./event-ledger-schema.ts";
export type { PostgresAppendHooks, PostgresEventStoreScope } from "./pg-event-store.ts";
export { makePostgresTaskEventStore } from "./pg-task-event-store.ts";
export type {
  PostgresTaskEventCapabilityOptions,
  PostgresTaskEventStoreRequest,
  PostgresTaskEventStoreResult,
  PostgresWriterFence,
} from "./pg-task-event-store.ts";
export {
  makePgCanonicalEventStore,
  type PgCanonicalEventStoreOptions,
  type PgGitFollowerHandle,
  type PgGitFollowerMountContext,
  type PgSqlQueryReaderFactory,
} from "./pg-canonical-event-store.ts";
export { openPgWriterEpoch } from "./pg-writer-epoch.ts";
export { openPgReplicationSlots } from "./pg-slot-client.ts";
export {
  createPgStorageBackend,
  resolvePostgresEventStoreScope,
  type PgStorageBackend,
  type PgStorageBackendOptions,
} from "../pg/backend.ts";
export {
  createPgTaskQueryReader,
  withStorageWriteRequest,
  withStorageWriteRequestSync,
  activeStorageWriteRequest,
  type PgQueryConnectionOptions,
  type PgTaskQueryMethods,
  type PgTaskQueryReader,
  type PgTaskQueryReaderOptions,
  type StorageWriteRequest,
} from "../pg/pg-task-query-reader.ts";
export { makePgTaskProjection } from "../pg/pg-task-projection.ts";
export {
  createPgEntityStore,
  type PgEntityDeclarationStore,
  type PgEntityDeclarationWrite,
  type PgEntityStoreOptions,
} from "../pg/pg-entity-store.ts";
export {
  assertWriterEpochFenceDescriptor,
  closeWriterEpochFenceDescriptors,
  openPersistentWriterEpoch,
  withWriterEpochFenceDescriptor,
  WriterEpochError,
} from "../writer-epoch.ts";
export type { PersistentWriterEpoch, WriterEpochFenceDescriptor, WriterEpochLease } from "../writer-epoch.ts";
export { configureWriterEpochStorage } from "../writer-epoch-storage.ts";
export {
  readNodeMaterializationDocuments,
  requireTaskMaterializationMetadata,
  resolveStorageBackend,
  storageForWriter,
  unsupportedStorageBackendError,
} from "../storage-backend.ts";
export type {
  PostgresStorageBackendConfig,
  StorageBackend,
  StorageBackendConfig,
  StorageBackendOptions,
  StorageScope,
} from "../storage-backend.ts";
export {
  makeTaskProjection,
  makeTaskProjectionReader,
  ProjectionIdentityMismatchError,
  type TaskProjection,
  type TaskProjectionPort,
  type TaskProjectionQueries,
  type TaskProjectionReader,
  type TaskProjectionReaderPort,
} from "../projection/rebuildable-task-projection.ts";
export {
  createEntityStore,
  openEntityStore,
  type EntityDeclarationStorePort,
  type OpenedEntityStore,
  type StoredEntity,
} from "../store/entity-store.ts";
export {
  CANONICAL_EVENT_REF,
  canonicalEventEntityRefs,
  TaskEventStoreError,
  type CanonicalContentBlob,
  type CanonicalEventAppendReceipt,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalEventStreamV1,
  type CanonicalWriteBundle,
  type LedgerEventStorePort,
  type MaterializationHealth,
  type MaterializationReceipt,
  type MaterializationRequest,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
export {
  canonicalEventCut,
  canonicalLedgerCut,
  validateCanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
export {
  installStorageWorkerContext,
  prepareStorageWorkerContext,
  requiresStorageWorkerContext,
  type StorageWorkerContext,
} from "../storage-worker-context.ts";
export * from "../durable-file.ts";
export type { DaemonStorageConfig } from "../storage-daemon-composition.ts";
