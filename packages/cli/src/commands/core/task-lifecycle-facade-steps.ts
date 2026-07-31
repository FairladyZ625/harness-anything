import type { ParsedCommand } from "../../cli/types.ts";
import { commandForRootResolution, resolveCommandRoot } from "../../daemon/root-resolution.ts";

export type TaskStartCommand = ParsedCommand & {
  readonly action: Extract<ParsedCommand["action"], { readonly kind: "task-start" }>;
};

export function resolveFacadeCommandRoot(command: ParsedCommand): ParsedCommand {
  return commandForRootResolution(command, resolveCommandRoot(command));
}

export function taskStartFacadeSteps(command: TaskStartCommand): ReadonlyArray<ParsedCommand> {
  const action = command.action;
  return [{
    ...command,
    action: {
      kind: "task-claim",
      taskId: action.taskId,
      execution: true,
      ...(action.executionId ? { executionId: action.executionId } : {}),
      ...(action.ttlMs === undefined ? {} : { ttlMs: action.ttlMs })
    }
  }];
}
