import {
  isLedgerLayoutMigrationEvent,
  migrateEventsToSqlite,
  openSqliteEventStore,
  runDispatchRecordMigration,
  runEventShapeMigration,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

type EventShapeMigrationSpec = Parameters<typeof runEventShapeMigration>[0];

export function runEventShapeMigrationAction(
  cell: RepoCellOperationalContext,
  migration: EventShapeMigrationSpec,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  return runEventShapeMigration(migration, {
    dryRun: action.dryRun === true,
    actor: binding.actor,
    rootDir: cell.rootDir,
    store: cell.store,
    now: cell.now,
  });
}

export function runDispatchRecordMigrationAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  return runDispatchRecordMigration({
    dryRun: action.dryRun === true,
    actor: binding.actor,
    source: binding.source,
    rootDir: cell.rootDir,
    store: cell.store,
    projection: cell.projection,
    now: cell.now,
    settleLease: (settlement) => cell.settleRuntimeExecutionLease(settlement, binding),
  });
}

function runSqliteGenerationMigrationAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  generation: number,
) {
  const fence = binding.writerEpochFence;
  if (!fence) throw cell.cellCodedError("invalid_command", "SQLite generation migration requires a writer fence.");
  const sqlite = openSqliteEventStore({ repoId: cell.input.repoId, rootInput: cell.rootDir, generation });
  try {
    const migration = migrateEventsToSqlite({
      store: sqlite,
      repoId: cell.input.repoId,
      events: cell.store.read().events,
      holder: fence.holderId,
      epoch: fence.epoch,
    });
    return cell.readResult(
      cell.operationId(action, binding, cell.input.repoId, migration.revision),
      migration,
      migration.revision,
      null,
    );
  } finally {
    sqlite.close();
  }
}

export async function runLedgerMigrateAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  if (typeof action.generation === "number")
    return runSqliteGenerationMigrationAction(cell, action, binding, action.generation);
  await cell.store.settlePendingMaterialization?.("layout migration");
  const appended = cell.store.migrateLayout({
    actor: binding.actor,
    source: binding.source,
    occurredAt: cell.now(),
  });
  if (!isLedgerLayoutMigrationEvent(appended.event))
    throw cell.cellCodedError("invalid_store", "Ledger migration returned the wrong event type.");
  cell.projection.catchUp?.();
  const projected = cell.projection.list(),
    visible = projected.watermark === appended.revision && projected.sourceRevision === appended.revision,
    proof = {
      committedRevision: appended.revision,
      appliedCut: projected.watermark,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: true,
    },
    receipt = {
      opId: appended.event.opId,
      revision: appended.revision,
      evidence: JSON.stringify({
        ...appended.event.payload,
        commitSha: appended.commitSha?.sha ?? null,
        projection: {
          status: projected.status,
          watermark: projected.watermark,
          sourceRevision: projected.sourceRevision,
        },
      }),
      visibility: "center" as const,
      proof,
      commitSha: appended.commitSha?.sha ?? null,
      cut: appended.cut,
      worktreeVisible: true,
    };
  return visible
    ? ({ outcome: "applied", ...receipt } as WriteReceipt)
    : ({
        outcome: "pending",
        ...receipt,
      } as WriteReceipt);
}
