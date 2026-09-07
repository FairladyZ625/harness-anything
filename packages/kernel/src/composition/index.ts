export {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  canonicalEventCut,
  canonicalEventWritePlan,
  TaskEventStoreError,
} from "../store/task-event-store.ts";
export { makeTaskEventReader, makeTaskEventStore } from "../store/task-event-store-factory.ts";
export { readCertifiedGitFollower } from "../store/task-event-store-factory.ts";
export type {
  CertifiedGitFollower,
  SqliteCanonicalEventStore,
  SqliteTaskEventStoreOptions,
} from "../store/task-event-store-factory.ts";
export type { DispatchRecordLeaseSettlement } from "../store/dispatch-record-lease.ts";
export { ledgerGitPath, resolveLedgerGitLayout } from "../store/ledger-git-layout.ts";
export { eventShapeMigrations } from "../store/event-shape-migration.ts";
export { migrateEventsToSqlite, openSqliteEventStore, sqliteLedgerPath } from "../store/sqlite-event-store.ts";
export { reconcileSqliteEvents } from "../store/sqlite-ledger-reconcile.ts";
export {
  activateEmptyCanonicalGeneration,
  createImmutableLegacyGenerationSnapshotFromStoppedRepository,
  preflightCanonicalGeneration,
} from "../store/legacy-generation-conversion.ts";
export type { StoppedLegacySourceEvidenceV1 } from "../store/legacy-generation-conversion.ts";
export { resolveRetirableDocument } from "../store/ledger-document.ts";
export type {
  CanonicalContentBlob,
  CanonicalEventAppendReceipt,
  CanonicalEventCut,
  CanonicalEventStore,
  CanonicalWriteBundle,
  EventPublicationKillpoint,
  MaterializationHealth,
  MaterializationState,
  PublicationFile,
} from "../store/task-event-store.ts";
export { makeTaskProjection, makeTaskProjectionReader } from "../projection/rebuildable-task-projection.ts";
export type {
  ProjectionPage,
  ReplicaProjectionBasis,
  TaskIndexProjectionRow,
  TaskProjection,
  TaskProjectionQueries,
  TaskProjectionReader,
  TaskProjectionWriter,
  TaskProjectionListQuery,
  TaskRelationProjectionRead,
  TaskRelationQuery,
  TaskRelationNeighborhoodQuery,
} from "../projection/rebuildable-task-projection.ts";
export {
  configureLedgerMaintenance,
  localGitObjectRefStore,
  localGitWorktreeSettlement,
  makeLocalVersionControlSystem,
} from "../store/local-version-control-system.ts";
export { createEntityStore, openEntityStore } from "../store/entity-store.ts";
export type { EntityStore } from "../store/entity-store.ts";

export {
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  legacyGenerationSnapshotPath,
  planLegacyGenerationSnapshotConversion,
  preflightConvertedGenerationActivation,
  readImmutableLegacyGenerationSnapshot,
} from "../store/legacy-generation-conversion.ts";
export { sqliteContentObjectPath } from "../store/sqlite-event-store.ts";
export { assertNoPendingHistoricalRewrites, planLegacyGenerationConversion } from "../store/event-shape-migration.ts";
