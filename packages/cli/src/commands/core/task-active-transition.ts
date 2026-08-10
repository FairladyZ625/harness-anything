import { Effect } from "effect";
import {
  makeTaskLifecycleOrchestrator,
  validateTaskActivationReadiness
} from "@harness-anything/application";
import { cliError, CliErrorCode, isCliErrorCode } from "../../cli/error-codes.ts";
import type { IndeterminateFlushControlOutcome } from "@harness-anything/kernel";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./task-document-placeholders.ts";

export type ActiveStatusPreflightResult =
  | { readonly ok: true; readonly taskPlanBodySha256: string }
  | { readonly ok: false; readonly result: CliResult };

export function preflightActiveStatusSet(
  context: CommandRunnerContext,
  taskId: string
): Effect.Effect<ActiveStatusPreflightResult> {
  return validateTaskActivationReadiness({
    artifactStore: context.artifactStore,
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    taskId,
    policy: bundledTaskDocumentPlaceholderPolicy()
  }).pipe(Effect.map((result): ActiveStatusPreflightResult => result.ok
    ? { ok: true, taskPlanBodySha256: result.taskPlanBodySha256 }
    : {
        ok: false,
        result: {
          ok: false,
          command: "status-set",
          taskId: result.taskId,
          status: "active",
          error: cliError(
            isCliErrorCode(result.error.code) ? result.error.code : CliErrorCode.WriteRejected,
            result.error.hint
          )
        }
      }));
}

export function runActiveStatusSet(context: CommandRunnerContext, taskId: string): Effect.Effect<CliResult, IndeterminateFlushControlOutcome> {
  const orchestrator = makeTaskLifecycleOrchestrator({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides,
    taskWriter: context.engine,
    artifactStore: context.artifactStore,
    documentPlaceholderPolicy: bundledTaskDocumentPlaceholderPolicy()
  });
  return orchestrator.setTaskStatus({ taskId, status: "active" }).pipe(Effect.map((result): CliResult => {
    if (result.ok) {
      return {
        ok: true,
        command: "status-set",
        taskId: result.taskId,
        status: result.status
      };
    }
    return {
      ok: false,
      command: "status-set",
      taskId: result.taskId,
      status: "active",
      error: cliError(
        isCliErrorCode(result.error.code) ? result.error.code : CliErrorCode.WriteRejected,
        result.error.hint
      )
    };
  }));
}
