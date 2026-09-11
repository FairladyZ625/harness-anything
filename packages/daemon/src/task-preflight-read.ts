import {
  completionBlockers,
  currentSubmittedExecutions,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export async function preflightTaskCompletion(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    read = await cell.service.read(taskId),
    task = read.snapshot.task;
  if (!task) throw cell.cellCodedError("entity_not_found", `Task ${taskId} does not exist.`);
  const submitted = currentSubmittedExecutions(read.snapshot),
    executionId = submitted.length === 1 ? submitted[0]!.executionId : String(action.executionId ?? "<execution-id>"),
    context = cell.completionContext(taskId, read.snapshot, read.packagePath, binding, task.presetSnapshotDigest ?? ""),
    blockers = completionBlockers(read.snapshot, executionId, context);
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, read.snapshot.revision),
    {
      schema: "task-preflight/v1",
      taskId,
      executionId: executionId === "<execution-id>" ? null : executionId,
      blockers: blockers.map(({ code, gate, next }) => ({ code, summary: next.reason, command: next.command, gate })),
      advisories:
        submitted.length > 1
          ? [
              {
                code: "execution_ambiguous",
                summary: "More than one submitted execution cut exists.",
                command: `ha task preflight ${taskId} --execution-id <id>`,
              },
            ]
          : [],
      readOnly: true,
    },
    read.snapshot.revision,
    true,
  );
}
