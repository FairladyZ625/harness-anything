import { isTaskHolderError, type TaskHolderPrincipal } from "../../../../application/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult } from "../../cli/types.ts";

export function taskHolderPrincipal(context: CommandRunnerContext):
  | { readonly ok: true; readonly value: TaskHolderPrincipal }
  | { readonly ok: false; readonly result: CliResult } {
  try {
    return { ok: true, value: context.taskHolderPrincipal() };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "task-holder",
        error: cliError(CliErrorCode.AuthMissing, error instanceof Error ? error.message : String(error))
      }
    };
  }
}

export function taskHolderCommandFailure(error: unknown): CliResult {
  if (isTaskHolderError(error)) {
    return {
      ok: false,
      command: "task-holder",
      taskId: error.taskId,
      error: cliError(CliErrorCode.WriteRejected, error.message),
      report: {
        schema: "task-holder-error/v1",
        code: error.code,
        taskId: error.taskId,
        ...("holder" in error ? { holder: error.holder } : {}),
        ...("principal" in error ? { principal: error.principal } : {}),
        ...("leaseExpiresAt" in error ? { leaseExpiresAt: error.leaseExpiresAt } : {}),
        ...("orphan" in error ? { orphan: error.orphan } : {})
      }
    };
  }
  return {
    ok: false,
    command: "task-holder",
    error: cliError(CliErrorCode.JournalUnavailable, error instanceof Error ? error.message : String(error))
  };
}

export function resultForTaskHolderFailure(command: "task-claim" | "task-holder" | "task-release", taskId: string, result: CliResult): CliResult {
  return {
    ...result,
    command,
    taskId
  };
}
