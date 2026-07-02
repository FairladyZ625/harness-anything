import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { EngineError, WriteError } from "../../../../kernel/src/domain/index.ts";
import { createTaskPackagePath, generateTaskId, taskDocumentPath } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { lifecycleReason } from "./task-lifecycle-shared.ts";

type TaskSupersedeAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-supersede" }>;

export function runTaskSupersede(
  context: CommandRunnerContext,
  action: TaskSupersedeAction
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (action.confirm && action.confirm !== action.oldTaskId) {
    return Effect.succeed({
      ok: false,
      command: "task-supersede",
      taskId: action.oldTaskId,
      error: cliError(CliErrorCode.SupersedeConfirmMismatch, "The --confirm value must match the superseded task id.")
    } satisfies CliResult);
  }
  if (!action.byTaskId) return createReplacementTask(context, action);
  if (!action.confirm) {
    return Effect.succeed({
      ok: false,
      command: "task-supersede",
      taskId: action.oldTaskId,
      error: cliError(CliErrorCode.SupersedeConfirmRequired, "Use --confirm <old-task-id> when superseding by an existing task.")
    } satisfies CliResult);
  }
  if (!existsSync(taskDocumentPath(context.layoutInput, action.byTaskId, "INDEX.md"))) {
    return Effect.succeed({
      ok: false,
      command: "task-supersede",
      taskId: action.oldTaskId,
      error: cliError(CliErrorCode.SupersedeTargetNotFound, "The --by task id must resolve to an existing task package.")
    } satisfies CliResult);
  }
  return context.engine.archiveTask({
    taskId: action.oldTaskId,
    reason: lifecycleReason(action.reason, {
      supersededBy: action.byTaskId,
      deletedBy: action.deletedBy,
      allowOpenFindings: action.allowOpenFindings ? "true" : undefined
    })
  }).pipe(Effect.map((result): CliResult => ({
    ok: true,
    command: "task-supersede",
    taskId: result.taskId,
    path: "INDEX.md",
    report: {
      schema: "task-supersede-existing-report/v1",
      supersededBy: action.byTaskId,
      allowOpenFindings: action.allowOpenFindings,
      deletedBy: action.deletedBy,
      relationSemantics: "not-created"
    }
  })));
}

function createReplacementTask(
  context: CommandRunnerContext,
  action: TaskSupersedeAction
): Effect.Effect<CliResult, EngineError | WriteError> {
  const newTaskId = generateTaskId();
  const slug = action.slug ?? "replacement-task";
  return context.engine.supersedeTask({
    oldTaskId: action.oldTaskId,
    newTaskId,
    title: action.title ?? "Replacement Task",
    slug,
    reason: lifecycleReason(action.reason, {
      deletedBy: action.deletedBy,
      allowOpenFindings: action.allowOpenFindings ? "true" : undefined
    })
  }).pipe(Effect.map((result): CliResult => ({
    ok: true,
    command: "task-supersede",
    taskId: result.oldTaskId,
    path: `task/${result.newTaskId}`,
    packagePath: path.relative(context.rootDir, createTaskPackagePath(context.layoutInput, result.newTaskId, slug)).split(path.sep).join("/")
  })));
}
