import type { TaskHolderService } from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "./types.ts";

export async function normalizeExecutionSubmissionCommand(
  command: ParsedCommand,
  taskHolderService: Pick<TaskHolderService, "holder">
): Promise<ParsedCommand> {
  const action = command.action;
  if (action.kind !== "status-set" || !action.executionSubmission || action.executionSubmission.executionId) {
    return command;
  }
  const snapshot = await taskHolderService.holder({ taskId: action.taskId });
  const executionId = snapshot.holder?.schema === "task-holder/v2"
    ? snapshot.holder.executionId
    : undefined;
  if (!executionId) return command;
  return {
    ...command,
    action: {
      ...action,
      executionSubmission: { ...action.executionSubmission, executionId }
    }
  };
}
