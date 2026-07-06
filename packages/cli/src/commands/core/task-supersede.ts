import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { EngineError, WriteError } from "../../../../kernel/src/index.ts";
import { createTaskPackagePath, generateTaskId, readFrontmatter, readScalar, taskDocumentPath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { materializePresetTaskScaffold, renderTemplateBody } from "../preset-task.ts";
import { readProjectHarnessSettings } from "../settings.ts";
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
  const title = action.title ?? "Replacement Task";
  return Effect.gen(function* () {
    const scaffoldSource = readSupersededTaskScaffoldSource(context, action.oldTaskId);
    if (!scaffoldSource.ok) return yield* Effect.fail(scaffoldSource.error);
    const settingsResult = readProjectHarnessSettings(context.layoutInput, "task-supersede");
    if (!settingsResult.ok) return settingsResult.result;
    const scaffold = scaffoldSource.vertical === "software/coding"
      ? materializePresetTaskScaffold(context.layoutInput, {
        command: "task-supersede",
        vertical: scaffoldSource.vertical,
        presetId: scaffoldSource.preset,
        profileId: scaffoldSource.profile ?? settingsResult.settings.defaultProfile,
        locale: settingsResult.settings.locale ?? "zh-CN"
      }, settingsResult.settings)
      : { ok: true as const, materialized: { documents: [] } };
    if (!scaffold.ok) return scaffold.result;
    return yield* context.engine.supersedeTask({
      oldTaskId: action.oldTaskId,
      newTaskId,
      title,
      slug,
      reason: lifecycleReason(action.reason, {
        deletedBy: action.deletedBy,
        allowOpenFindings: action.allowOpenFindings ? "true" : undefined
      }),
      scaffoldDocuments: scaffold.materialized.documents.map((document) => ({
        path: document.materializeAs,
        body: renderTemplateBody(document.body, title)
      }))
    }).pipe(Effect.map((result): CliResult => ({
      ok: true,
      command: "task-supersede",
      taskId: result.oldTaskId,
      path: `task/${result.newTaskId}`,
      packagePath: path.relative(context.rootDir, createTaskPackagePath(context.layoutInput, result.newTaskId, slug)).split(path.sep).join("/")
    })));
  });
}

function readSupersededTaskScaffoldSource(
  context: CommandRunnerContext,
  taskId: string
): { readonly ok: true; readonly vertical: string; readonly preset: string; readonly profile?: string } | { readonly ok: false; readonly error: EngineError } {
  try {
    const body = readFileSync(taskDocumentPath(context.layoutInput, taskId, "INDEX.md"), "utf8");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter) return { ok: false, error: { _tag: "MalformedSnapshot", raw: "INDEX.md missing frontmatter" } };
    const profile = frontmatter.match(/^profile:[ \t]*(.*)$/mu)?.[1]?.trim() ?? "";
    return {
      ok: true,
      vertical: readScalar(frontmatter, "vertical", { required: true }),
      preset: readScalar(frontmatter, "preset", { required: true }),
      ...(profile ? { profile } : {})
    };
  } catch (cause) {
    return isNodeErrorCode(cause, "ENOENT")
      ? { ok: false, error: { _tag: "TaskNotFound", taskId } }
      : { ok: false, error: { _tag: "MalformedSnapshot", raw: cause instanceof Error ? cause.message.replace(/'[^']*'/gu, "[path]") : "malformed task package" } };
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
