import { type WriteReceiptDraft as WriteReceipt } from "../../kernel/src/index.ts";
import {
  defaultProjectionWaitMs,
  isProjectionWaitMs,
  projectionWaitBudget,
  waitForProjectionCut,
  waitForTaskProjection,
} from "./projection-readiness-wait.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export async function runFactAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const { waitProjectionMs: requestedWait, ...factAction } = action,
    waitProjectionMs = requestedWait ?? defaultProjectionWaitMs;
  if (!isProjectionWaitMs(waitProjectionMs))
    throw cell.cellCodedError(
      "invalid_command",
      "waitProjectionMs must be a non-negative safe integer number of milliseconds.",
    );
  if (factAction.kind === "fact-record") {
    const budget = projectionWaitBudget(waitProjectionMs),
      taskId = typeof factAction.taskId === "string" && factAction.taskId.trim() ? factAction.taskId : null;
    if (taskId)
      await waitForTaskProjection({
        budget,
        projection: cell.projection,
        store: cell.store,
        taskId,
        purpose: "fact record",
      });
    await waitForProjectionCut({
      budget,
      label: "Fact projection for fact record",
      read: () => cell.projection.searchFacts(taskId ? { taskId } : {}),
    });
  }
  return cell.entityActionExecutor.run(
    factAction,
    binding,
    cell.operationId(
      factAction,
      binding,
      cell.input.repoId,
      factAction.kind === "fact-record" && typeof factAction.taskId === "string" && factAction.taskId.trim().length > 0
        ? cell.projection.read(factAction.taskId).snapshot.revision
        : (cell.store.readHead()?.revision ?? 0),
    ),
  );
}
