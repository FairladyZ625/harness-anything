import { type WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import { withObservedCommit } from "./fact-observed-commit.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export function runFactAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt | Promise<WriteReceipt> {
  if (action.kind !== "fact-show" && action.kind !== "fact-type-list")
    return Promise.resolve().then(() => runFactActionNow(cell, action, binding));
  return runFactActionNow(cell, action, binding);
}

function runFactActionNow(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt | Promise<WriteReceipt> {
  // Fact admission itself requires the complete projection cut; the linked task is checked here.
  const taskId =
    action.kind === "fact-record" && typeof action.taskId === "string" && action.taskId.trim() ? action.taskId : null;
  // A fresh record names the commit it was observed against; the observation-snapshot events
  // (reclassify/archive/unarchive) keep the value their projection row already carries.
  const admitted =
    action.kind === "fact-record" || action.kind === "fact-type-register"
      ? withObservedCommit(cell.rootDir, action as Readonly<Record<string, unknown>>)
      : action;
  return cell.entityActionExecutor.run(
    admitted as RepoTaskAction,
    binding,
    cell.operationId(
      action,
      binding,
      cell.input.repoId,
      taskId
        ? requireCurrentTaskProjection(cell.projection, taskId, "fact record").snapshot.revision
        : action.kind === "fact-show" || action.kind === "fact-type-list"
          ? cell.projection.readCut().sourceRevision
          : (cell.store.readHead()?.revision ?? 0),
    ),
  );
}
