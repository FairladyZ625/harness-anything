export * from "./store/index.ts";
export { resolveStorageBackend, unsupportedStorageBackendError } from "./storage-backend.ts";
export type {
  PostgresStorageBackendConfig,
  ResolvedStorageBackend,
  SqliteStorageBackendConfig,
  StorageBackend,
  StorageBackendConfig,
  StorageBackendOptions,
  StorageScope,
} from "./storage-backend.ts";
export {
  makeTaskProjection,
  makeTaskProjectionReader,
  ProjectionIdentityMismatchError,
} from "./projection/rebuildable-task-projection.ts";
export type {
  PostgresTaskProjectionFactoryOptions,
  PostgresTaskProjectionReaderFactoryOptions,
  TaskProjectionFactoryOptions,
  TaskProjectionReaderFactoryOptions,
} from "./projection/rebuildable-task-projection-factory.ts";
export { readLegacyMigrationSource } from "./projection/cold-rebuild-source.ts";
export {
  legacyRelationManualReason,
  normalizeLegacyRelationMigrationEvent,
} from "./projection/relation-migration-normalization.ts";
export { readMarkdownSource, taskEntryToRow } from "./projection/sqlite-task-source.ts";
export type { TaskSourceEntry } from "./projection/sqlite-task-source.ts";
export { projectDecisionReadiness } from "./projection/decision-readiness-projection.ts";
export type {
  ColdDecisionProjectionRow,
  ColdRebuildIssue,
  ColdRebuildSource,
} from "./projection/cold-rebuild-source.ts";
export { eventShapeMigrations } from "./store/event-shape-migration.ts";
export { registerDaemonRepo } from "./storage-daemon-composition.ts";
export { createReplicationRetention, openReplicationSlots, replicationSlotKey } from "./fleet-replication-slot.ts";
export type {
  ReplicaDeliveryKey,
  ReplicationAcknowledgement,
  ReplicationSlotKey,
  ReplicationSlotLease,
  ReplicationSlots,
} from "./fleet-replication-slot.ts";
export { replicaDeliveryLeases } from "./fleet-replica-delivery-lease.ts";
export type { ReplicaDeliveryLease, ReplicaTransferMetrics } from "./fleet-replica-delivery-lease.ts";
export {
  assertWriterEpochFenceDescriptor,
  closeWriterEpochFenceDescriptors,
  migrateLegacyWriterEpochDatabase,
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  withWriterEpochFenceDescriptor,
  WriterEpochError,
} from "./writer-epoch.ts";
export type { PersistentWriterEpoch, WriterEpochFenceDescriptor, WriterEpochLease } from "./writer-epoch.ts";
export { startBaseBackup } from "./fleet-basebackup.ts";
export type { BaseBackupArchive, BaseBackupInput, BaseBackupMetadata } from "./fleet-basebackup.ts";
export { BASE_BACKUP_ARCHIVE_ROOT } from "./fleet-basebackup-layout.ts";

export * from "./durable-file.ts";

export * from "./migration-projection-oracle.ts";
export * from "./migration-values.ts";
