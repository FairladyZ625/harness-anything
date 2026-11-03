export * from "./entity-store.ts";
export type { DispatchRecordLeaseSettlement } from "./dispatch-record-lease.ts";
export { cmdShellInvocation } from "./cmd-command-line.ts";
export * from "./local-version-control-system.ts";
export { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
export { migrateEventsToSqlite, openSqliteEventStore, sqliteLedgerPath } from "./sqlite-event-store.ts";
export { resolveActiveGeneration } from "./sqlite-event-store.ts";
export { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel/internal/domain/task-lifecycle-event.ts";
export { reconcileSqliteEvents } from "./sqlite-ledger-reconcile.ts";
export { openReplicaStore } from "./replica-store.ts";
export type { ReplicationCommit, ReplicationPosition } from "./replication-log.ts";
export { contentClaims as replicationContentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
export {
  createLedgerBackup,
  drillLedgerBackup,
  readOfflineLedgerEvents,
  readVerifiedLedgerBackup,
  restoreLedgerBackup,
  restoreDrillRetentionFor,
} from "./ledger-backup.ts";
export { applyLedgerBackupRetention, type LedgerBackupRetentionPolicyV1 } from "./ledger-backup-retention.ts";
export {
  activateEmptyCanonicalGeneration,
  convertLegacyGeneration,
  createImmutableLegacyGenerationSnapshot,
  createImmutableLegacyGenerationSnapshotFromStoppedRepository,
  legacyGenerationSnapshotPath,
  planLegacyGenerationSnapshotConversion,
  readImmutableLegacyGenerationSnapshot,
} from "./legacy-generation-conversion.ts";
export type { StoppedLegacySourceEvidenceV1 } from "./legacy-generation-conversion.ts";
export { assertNoPendingHistoricalRewrites, planLegacyGenerationConversion } from "./event-shape-migration.ts";
export { applyAttachMigrations } from "./attach-migrations.ts";
export * from "./task-event-store.ts";
export { runCompletionGenerationConversion } from "./completion-generation-conversion.ts";
