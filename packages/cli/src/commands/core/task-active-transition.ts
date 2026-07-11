import { Effect } from "effect";
import { makeTaskLifecycleOrchestrator } from "../../../../application/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./task-document-placeholders.ts";

export function runActiveStatusSet(context: CommandRunnerContext, taskId: string): Effect.Effect<CliResult> {
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
