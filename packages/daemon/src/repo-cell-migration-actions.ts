import { runDispatchRecordMigration, runEventShapeMigration } from "../../kernel/src/index.ts";
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
