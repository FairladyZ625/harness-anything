// Driver-pure SQLite subpath entrypoint: zero pg, zero @electric-sql/pglite, zero Git/child_process subprocesses.
export { readAuthoredNode, authoredNodeFingerprint, type AuthoredNode } from "../authored-node-read.ts";
export {
  makeSqliteTaskEventStore,
  sqliteEventBatch,
  pendingFollower,
  type DaemonWriterFence,
  type MaterializationDocumentDescriptor,
  type SqliteCanonicalEventStore,
  type SqliteGitFollowerHandle,
  type SqliteGitFollowerMountContext,
  type SqliteTaskEventStoreOptions,
} from "../store/sqlite-task-event-store.ts";
export {
  activateEmptyCanonicalGeneration,
  migrateEventsToSqlite,
  openSqliteEventStore,
  openUnactivatedGenerationThreeEventStore,
  preflightCanonicalGeneration,
  preflightGenerationTwoActivation,
  readGenerationTwoActivation,
  resolveActiveGeneration,
  sqliteContentObjectPath,
} from "../store/sqlite-event-store.ts";
export type {
  SqliteCommandIntent,
  SqliteCommandOutcome,
  SqliteDocumentHead,
  SqliteEventIdentity,
  SqliteEventRow,
  SqliteEventStore,
  SqliteEventStoreOpenOptions,
  SqliteGitOutboxState,
  SqliteLedgerMetadata,
  SqliteOutboxBaseline,
  SqliteWriterFence,
} from "../store/sqlite-event-store-types.ts";
export { sqliteLedgerPath, SQLITE_LEDGER_GENERATION } from "../store/sqlite-ledger-layout.ts";
export { closeSqliteEventStoresUnder } from "../store/sqlite-ledger-connections.ts";
export { applyAttachMigrations } from "../store/attach-migrations.ts";
export {
  createEntityStore,
  openEntityStore,
  type EntityDeclarationStorePort,
  type OpenedEntityStore,
  type StoredEntity,
} from "../store/entity-store.ts";
export {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
export {
  CANONICAL_EVENT_REF,
  canonicalEventEntityRefs,
  materializationStates,
  TaskEventStoreError,
  type CanonicalContentBlob,
  type CanonicalEventAppendReceipt,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalEventStreamV1,
  type CanonicalPublicationIdentity,
  type CanonicalWriteBundle,
  type EventFileBatch,
  type EventPublicationKillpoint,
  type LedgerEventStorePort,
  type MaterializationFailureReason,
  type MaterializationHealth,
  type MaterializationReceipt,
  type MaterializationRequest,
  type MaterializationState,
  type PublicationMetrics,
  type TaskEventStoreErrorCode,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
export {
  canonicalEventContentClaims,
  canonicalEventCut,
  canonicalEventWritePlan,
  canonicalLedgerCut,
  validateCanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
export {
  makeTaskProjection,
  makeTaskProjectionReader,
  ProjectionIdentityMismatchError,
  closeTaskProjectionsUnder,
  defaultLifecycleTaskProjectionPath,
} from "../projection/rebuildable-task-projection.ts";
export type {
  TaskProjection,
  TaskProjectionFactoryOptions,
  TaskProjectionPort,
  TaskProjectionQueries,
  TaskProjectionReader,
  TaskProjectionReaderFactoryOptions,
  TaskProjectionReaderPort,
} from "../projection/rebuildable-task-projection.ts";
export {
  readNodeMaterializationDocuments,
  requireTaskMaterializationMetadata,
  resolveStorageBackend,
  storageForWriter,
  unsupportedStorageBackendError,
} from "../storage-backend.ts";
export type {
  ResolvedStorageBackend,
  SqliteStorageBackendConfig,
  StorageBackend,
  StorageBackendConfig,
  StorageBackendOptions,
  StorageScope,
} from "../storage-backend.ts";
export {
  assertWriterEpochFenceDescriptor,
  closeWriterEpochFenceDescriptors,
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  withWriterEpochFenceDescriptor,
  WriterEpochError,
} from "../writer-epoch.ts";
export type { PersistentWriterEpoch, WriterEpochFenceDescriptor, WriterEpochLease } from "../writer-epoch.ts";
export { configureWriterEpochStorage } from "../writer-epoch-storage.ts";
export {
  prepareStorageWorkerContext,
  installStorageWorkerContext,
  requiresStorageWorkerContext,
  type StorageWorkerContext,
} from "../storage-worker-context.ts";
export * from "../durable-file.ts";
export type { DaemonStorageConfig } from "../storage-daemon-composition.ts";
export { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
