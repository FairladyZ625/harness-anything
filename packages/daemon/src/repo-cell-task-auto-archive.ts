import type { WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";

/**
 * The lightweight closeout path: a task whose profile declares archiveOnComplete is archived
 * through the regular task-archive action right after its completion event applies — never
 * inside the completion write itself. An archive failure is reported as a warning instead of
 * misreporting the already-committed completion.
 */
export function archiveTaskOnComplete(
  cell: RepoCellOperationalContext,
  taskId: string,
  snapshot: Snapshot,
  binding: RepoCellBinding,
): { readonly receipt: WriteReceipt | null; readonly warning: string | null } {
  const task = snapshot.task;
  if (task?.archiveOnComplete !== true || (task.packageDisposition ?? "active") !== "active")
    return { receipt: null, warning: null };
  try {
    return {
      receipt: cell.archiveTasks(
        {
          kind: "task-archive",
          taskIds: [taskId],
          reason: "Archived automatically: the task's preset profile declares archiveOnComplete.",
        } as RepoTaskAction,
        binding,
      ),
      warning: null,
    };
  } catch (error) {
    return {
      receipt: null,
      warning: `Auto-archive after completion failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
