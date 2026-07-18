import type { TaskHolderService } from "../../../kernel/src/index.ts";
import { normalizeDecisionProposeAction } from "./decision-propose-normalizer.ts";
import { normalizeExecutionSubmissionCommand } from "./execution-submission-normalizer.ts";
import type { ParsedCommand } from "./types.ts";

export async function normalizeCommandSemantics(
  command: ParsedCommand,
  taskHolderService: Pick<TaskHolderService, "holder">
): Promise<ParsedCommand> {
  const parsed = command.action.kind === "decision-propose"
    ? { ...command, action: normalizeDecisionProposeAction(command.action) }
    : command;
  return normalizeExecutionSubmissionCommand(parsed, taskHolderService);
}
