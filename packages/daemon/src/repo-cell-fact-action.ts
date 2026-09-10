import { type WriteReceiptDraft as WriteReceipt } from "../../kernel/src/index.ts";
import { requireCurrentTaskProjection } from "./projection-readiness.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export async function runFactAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  // Fact admission itself requires the complete projection cut; the linked task is checked here.
  const taskId =
    action.kind === "fact-record" && typeof action.taskId === "string" && action.taskId.trim() ? action.taskId : null;
  return cell.entityActionExecutor.run(
    action,
    binding,
    cell.operationId(
      action,
      binding,
      cell.input.repoId,
      taskId
        ? requireCurrentTaskProjection(cell.projection, taskId, "fact record").snapshot.revision
        : (cell.store.readHead()?.revision ?? 0),
    ),
  );
}
