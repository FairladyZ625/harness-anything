import {
  canonicalDaemonRegistryRoot,
  writeDaemonRegistryRepo,
  type DaemonRegistryRegisterInput,
} from "../daemon/registry.ts";
import { resolveLedgerGitLayout } from "../store/ledger-git-layout.ts";
import {
  configureLedgerMaintenance,
  installLedgerCommitGuard,
  makeLocalVersionControlSystem,
} from "../store/local-version-control-system.ts";
export {
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  canonicalEventCut,
  canonicalEventEntityRefs,
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
  migrateEventsToSqlite,
  openSqliteEventStore,
  resolveActiveGeneration,
  sqliteLedgerPath,
} from "../store/sqlite-event-store.ts";
export { reconcileSqliteEvents } from "../store/sqlite-ledger-reconcile.ts";
export {
  createLedgerBackup,
  drillLedgerBackup,
  readVerifiedLedgerBackup,
  restoreLedgerBackup,
  readOfflineLedgerEvents,
  restoreDrillRetentionFor,
  runGenerationTwoConversion,
} from "../store/ledger-backup.ts";
export { applyLedgerBackupRetention, type LedgerBackupRetentionPolicyV1 } from "../store/ledger-backup-retention.ts";
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
  HARNESS_LEDGER_WRITER_ENV,
  installLedgerCommitGuard,
  localGitObjectRefStore,
  localGitWorktreeSettlement,
  makeLocalVersionControlSystem,
} from "../store/local-version-control-system.ts";

export function registerDaemonRepo(input: DaemonRegistryRegisterInput) {
  if (!input.canonicalRoot || input.mode === "remote-proxy") return writeDaemonRegistryRepo(input);
  const canonicalRoot = canonicalDaemonRegistryRoot(input.canonicalRoot),
    ledger = resolveLedgerGitLayout(canonicalRoot),
    vcs = makeLocalVersionControlSystem();
  // Attaching an existing ledger still owes it the machine configuration —
  // including the commit guard that refuses manual `git commit`. The guard is
  // offered the authored root, not the enclosing repository's top level, so it
  // stays out of a ledger that shares the project's repository.
  configureLedgerMaintenance(ledger.rootDir);
  installLedgerCommitGuard(ledger.authoredRoot);
  const branch = vcs.originHeadBranch(ledger.rootDir) ?? vcs.currentBranch(ledger.rootDir);
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
