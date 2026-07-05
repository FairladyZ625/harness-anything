import path from "node:path";
import { Effect } from "effect";
import { createTaskPackagePath, generateTaskId } from "../../../../kernel/src/layout/index.ts";
import { runNewTaskFromLegacy } from "../legacy-rebuild.ts";
import { runNewTaskWithPreset, shouldUsePresetAwareNewTask } from "../preset-task.ts";
import { readProjectHarnessSettings, shouldUseSettingsPresetAwareNewTask } from "../settings.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runNewTaskCommand: CommandRunner = (context, command) => {
  const action = command.action as Extract<typeof command.action, { readonly kind: "new-task" }>;
  if (action.fromLegacyId) return runNewTaskFromLegacy(context.layoutInput, action);

  const settingsResult = readProjectHarnessSettings(context.layoutInput, "new-task");
  if (!settingsResult.ok) return Effect.succeed(settingsResult.result);
  if (shouldUsePresetAwareNewTask(action) || shouldUseSettingsPresetAwareNewTask(settingsResult.settings)) {
    return runNewTaskWithPreset(context.layoutInput, action, settingsResult.settings, {
      currentSessionProbe: context.currentSessionProbe,
      provenanceSessionExporter: context.provenanceSessionExporter
    });
  }

  const taskId = action.taskId ?? generateTaskId();
  return context.engine.createTask({
    taskId,
    title: action.title,
    parent: action.parent,
    slug: action.slug,
    allowManualId: action.allowManualId
  }).pipe(Effect.map((result): CliResult => ({
    ok: true,
    command: "new-task",
    taskId: result.taskId,
    slug: action.slug,
    status: result.status,
    packagePath: path.relative(command.rootDir, createTaskPackagePath(context.layoutInput, result.taskId, action.slug)).split(path.sep).join("/")
  })));
};
