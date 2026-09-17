import {
  canonicalDaemonRegistryRoot,
  writeDaemonRegistryRepo,
  type DaemonRegistryRegisterInput,
} from "../daemon/registry.ts";
import { resolveLedgerGitLayout } from "../store/ledger-git-layout.ts";
import { makeLocalVersionControlSystem } from "../store/local-version-control-system.ts";
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
export {
  generationActivationPath,
  migrateEventsToSqlite,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "../store/sqlite-event-store.ts";
export { reconcileSqliteEvents } from "../store/sqlite-ledger-reconcile.ts";
export {
  createLedgerBackup,
  drillLedgerBackup,
  restoreLedgerBackup,
  readOfflineLedgerEvents,
  restoreDrillRetentionFor,
  runGenerationConversion,
} from "../store/ledger-backup.ts";
export {
  activateEmptyCanonicalGeneration,
  createImmutableLegacyGenerationSnapshotFromStoppedRepository,
} from "../store/legacy-generation-conversion.ts";
export type { StoppedLegacySourceEvidenceV1 } from "../store/legacy-generation-conversion.ts";
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

export function registerDaemonRepo(input: DaemonRegistryRegisterInput) {
  if (!input.canonicalRoot || input.mode === "remote-proxy") return writeDaemonRegistryRepo(input);
  const canonicalRoot = canonicalDaemonRegistryRoot(input.canonicalRoot),
    ledger = resolveLedgerGitLayout(canonicalRoot),
    vcs = makeLocalVersionControlSystem(),
    branch = vcs.originHeadBranch(ledger.rootDir) ?? vcs.currentBranch(ledger.rootDir);
  if (!branch) throw new Error(`canonicalRoot must have an attached default Git branch: ${ledger.rootDir}`);
  return writeDaemonRegistryRepo({ ...input, canonicalRoot, authoredBranch: branch });
}
export { createEntityStore, openEntityStore } from "../store/entity-store.ts";
export type { EntityStore } from "../store/entity-store.ts";

export {
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  legacyGenerationSnapshotPath,
  planLegacyGenerationSnapshotConversion,
  readImmutableLegacyGenerationSnapshot,
} from "../store/legacy-generation-conversion.ts";
export { sqliteContentObjectPath } from "../store/sqlite-event-store.ts";
export { assertNoPendingHistoricalRewrites, planLegacyGenerationConversion } from "../store/event-shape-migration.ts";
