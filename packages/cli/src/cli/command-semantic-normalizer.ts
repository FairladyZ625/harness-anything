import type { CurrentSessionRef, TaskHolderService } from "../../../kernel/src/index.ts";
import { normalizeDecisionProposeAction } from "./decision-propose-normalizer.ts";
import { normalizeExecutionSubmissionCommand } from "./execution-submission-normalizer.ts";
import type { ParsedCommand } from "./types.ts";

export async function normalizeCommandSemantics(
  command: ParsedCommand,
  taskHolderService: Pick<TaskHolderService, "holder">,
  currentSession?: CurrentSessionRef
): Promise<ParsedCommand> {
  let parsed = command.action.kind === "decision-propose"
    ? { ...command, action: normalizeDecisionProposeAction(command.action) }
    : command;
  if (parsed.action.kind === "record-fact" && !parsed.action.source && currentSession) {
    const snapshot = await taskHolderService.holder({ taskId: parsed.action.taskId });
    const executionId = snapshot.holder?.schema === "task-holder/v2"
      ? snapshot.holder.executionId
      : undefined;
    parsed = {
      ...parsed,
      action: {
        ...parsed.action,
        source: derivedFactSource(parsed.action.taskId, executionId, currentSession)
      }
    };
  }
  return normalizeExecutionSubmissionCommand(parsed, taskHolderService);
}

export function derivedFactSource(
  taskId: string,
  executionId: string | undefined,
  currentSession: CurrentSessionRef
): string {
  return executionId
    ? `execution/${taskId}/${executionId}`
    : `session/${currentSession.sessionId}`;
}

export function normalizedFactSource(
  action: Extract<ParsedCommand["action"], { readonly kind: "record-fact" }>
): string {
  if (action.source) return action.source;
  throw new Error("FACT_SOURCE_NOT_NORMALIZED: provide current session context before compiling or running fact record");
}
