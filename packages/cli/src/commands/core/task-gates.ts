import { Effect } from "effect";
import { makeTaskLifecycleOrchestrator, type TaskLifecycleResult } from "../../../../application/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode, type CliErrorCode as CliErrorCodeValue } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./task-document-placeholders.ts";

type TaskGateAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-review" | "task-complete" }>;

export const runTaskGatesCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskGateAction;
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    taskWriter: context.engine,
    documentPlaceholderPolicy: bundledTaskDocumentPlaceholderPolicy()
  });
  if (action.kind === "task-review") {
    return orchestrator.reviewTask({ taskId: action.taskId, reviewerId: action.reviewerId }).pipe(
      Effect.map((result): CliResult => taskLifecycleResultToCliResult("task-review", result))
    );
  }
  return orchestrator.completeTask({ taskId: action.taskId, reviewerId: action.reviewerId, ciGate: action.ciGate }).pipe(
    Effect.map((result): CliResult => taskLifecycleResultToCliResult("task-complete", result))
  );
};

function taskLifecycleResultToCliResult(command: "task-review" | "task-complete", result: TaskLifecycleResult): CliResult {
  if (result.ok) {
    return {
      ok: true,
      command,
      taskId: result.taskId,
      status: result.status,
      report: result.report,
      reviewContract: result.reviewContract,
      completionGate: result.completionGate
    };
  }
  return {
    ok: false,
    command,
    taskId: result.taskId,
    report: result.report,
    issues: result.issues,
    completionGate: result.completionGate,
    error: cliError(cliErrorCode(result.error.code), result.error.hint)
  };
}

function cliErrorCode(code: string): CliErrorCodeValue {
  // The orchestrator's writeFailureCode maps every kernel writer/engine error to a
  // registered CLI error code, so a real write failure (e.g. malformed_snapshot,
  // write_rejected) passes through untouched and surfaces its true cause. The
  // CompletionGateFailed fallback is a defensive guard for an unexpected unregistered
  // code, not the normal path — it must not mask a recognized writer error code.
  if (isCliErrorCode(code)) return code;
  return CliErrorCode.CompletionGateFailed;
}
