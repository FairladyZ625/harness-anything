import { statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type CanonicalEventStore } from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellOperationalContext } from "./repo-cell-types.ts";
import { presetSnapshotReader, taskWorktreeBinding } from "./task-worktree.ts";

/** The background request completes after an attempt. Disk readers need a covered revision. */
export async function settleAuthoredMaterialization(
  store: Pick<CanonicalEventStore, "materializationHealth" | "settlePendingMaterialization">,
  operation: string,
): Promise<void> {
  const before = store.materializationHealth();
  if (before.state === "ok" && before.pendingWalEvents === 0) return;
  const target = before.lastCheckpointRevision + before.pendingWalEvents;
  await store.settlePendingMaterialization?.(operation);
  const after = store.materializationHealth();
  if (after.state === "failed" || after.lastCheckpointRevision < target)
    throw cellCodedError(
      "materialization_failed",
      `Cannot ${operation}: the authored worktree has not settled revision ${target} (checkpoint ${after.lastCheckpointRevision}). Retry after Git publication recovers.`,
    );
}

/** Recheck the actual directory and its document revision at use, including changes since preparation. */
export function requireMaterializedDirectory(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "store">,
  documentPath: string,
  revision: number,
): string {
  const directory = path.dirname(documentPath),
    absolute = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, directory),
    workspaceDirectory = path.relative(cell.rootDir, absolute).split(path.sep).join("/"),
    worktree = cell.store.followerStatus().worktree,
    within = (target: string, parent: string) => target === parent || target.startsWith(`${parent}/`);
  if (
    (worktree.cut?.revision ?? 0) < revision ||
    worktree.conflicts?.some((target) => within(target, directory) || within(target, workspaceDirectory)) ||
    !statSync(absolute, { throwIfNoEntry: false })?.isDirectory()
  )
    throw cellCodedError(
      "materialization_failed",
      `Authored directory ${workspaceDirectory} is not visible at revision ${revision}. Retry after Git publication or resolve local document conflicts.`,
    );
  return workspaceDirectory;
}

export function requireTaskPackageMaterialization(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "store" | "projection">,
  taskId: string,
): void {
  const { packagePath, snapshot } = cell.projection.read(taskId);
  if (!packagePath || !snapshot.task || taskWorktreeBinding(snapshot.task, presetSnapshotReader(cell.projection)))
    return;
  const plan = `${packagePath}/task_plan.md`,
    revision = cell.projection.readDocumentMetadata(plan).document?.workspaceRevision ?? snapshot.revision;
  requireMaterializedDirectory(cell, plan, revision);
}
