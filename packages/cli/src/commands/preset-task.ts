import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeLocalWriteCoordinator } from "../../../adapters/local/src/index.ts";
import { resolveTaskCreatedBy } from "../../../adapters/local/src/created-by.ts";
import { indexPath, makeIndex, renderIndex, validateGeneratedTaskId, validateTaskId } from "../../../adapters/local/src/task-index.ts";
import type { EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import { createTaskPackagePath, generateTaskId } from "../../../kernel/src/layout/index.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { isInvalidPreset, materializePresetTaskDocuments, presetNotFound, publicPresetSummary, readModules, resolvePresetEntry, writeModules } from "./extensions/state.ts";
import { customVerticalGateResult, type ProjectHarnessSettings } from "./settings.ts";

type NewTaskAction = Extract<ParsedCommand["action"], { readonly kind: "new-task" }>;

export function shouldUsePresetAwareNewTask(action: NewTaskAction): boolean {
  return Boolean(action.vertical || action.preset || action.profile || action.moduleKey || action.registerModule || action.longRunning || action.dryRun || action.locale);
}

export function runNewTaskWithPreset(
  rootDir: string,
  action: NewTaskAction,
  settings?: ProjectHarnessSettings
): Effect.Effect<CliResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const vertical = action.vertical ?? settings?.defaultVertical ?? "software/coding";
    if (vertical !== "software/coding") {
      return customVerticalGateResult(rootDir, "new-task", settings);
    }

    let presetId = action.preset ?? settings?.defaultPreset ?? "standard-task";
    if (action.longRunning) presetId = "long-running-task";
    if (presetId === "module" && !action.moduleKey) {
      return {
        ok: false,
        command: "new-task",
        preset: { id: presetId },
        error: { code: "missing_module", hint: "Use new-task --preset module --module <key>." }
      } satisfies CliResult;
    }
    const preset = resolvePresetEntry(rootDir, presetId);
    if (!preset) return presetNotFound("new-task", presetId);
    if (isInvalidPreset(preset)) {
      return {
        ok: false,
        command: "new-task",
        preset: { id: preset.id, layer: preset.layer, valid: false },
        issues: preset.issues,
        error: { code: "preset_manifest_invalid", hint: "Preset manifest failed validation." }
      } satisfies CliResult;
    }

    const materialized = materializePresetTaskDocuments(preset.manifest, {
      profileId: action.profile ?? settings?.defaultProfile,
      locale: action.locale ?? settings?.locale ?? "zh-CN"
    });
    if (!materialized.ok || !materialized.profile) {
      return {
        ok: false,
        command: "new-task",
        preset: publicPresetSummary(preset),
        issues: materialized.issues,
        error: {
          code: "preset_materialization_failed",
          hint: "Preset-selected templates could not be materialized."
        }
      } satisfies CliResult;
    }

    const registeredModule = action.registerModule
      ? {
        key: action.registerModule.key,
        title: action.registerModule.title,
        ...(action.registerModule.prefix ? { prefix: action.registerModule.prefix } : {}),
        status: "active",
        scopes: [action.registerModule.scope],
        shared: [],
        dependsOn: [],
        steps: [] as Array<{ readonly id: string; readonly state: string }>
      }
      : undefined;
    const module = registeredModule
      ? registeredModule
      : action.moduleKey ? readModules(rootDir).modules.find((candidate) => candidate.key === action.moduleKey && candidate.status !== "unregistered") : undefined;
    if (action.moduleKey && !module) {
      return {
        ok: false,
        command: "new-task",
        module: { key: action.moduleKey },
        error: { code: "module_not_found", hint: `Module ${action.moduleKey} was not found.` }
      } satisfies CliResult;
    }

    const taskId = action.taskId ?? generateTaskId();
    if (!action.allowManualId) {
      const error = validateGeneratedTaskId(taskId);
      if (error) return yield* Effect.fail(error);
    } else {
      validateTaskId(taskId);
    }
    if (existsSync(indexPath(rootDir, taskId))) {
      return yield* Effect.fail({ _tag: "TaskAlreadyExists", taskId } satisfies EngineError);
    }

    const createdAt = new Date().toISOString();
    const index = makeIndex({
      taskId,
      title: action.title,
      status: "planned",
      bindingCreatedAt: createdAt,
      vertical,
      preset: preset.manifest.id,
      profile: materialized.profile.id,
      createdBy: resolveTaskCreatedBy(rootDir)
    }, stablePayloadHash);
    const writes = [
      { taskId, path: "INDEX.md", body: renderIndex(index), packageSlug: action.slug },
      ...materialized.documents.map((document) => ({
        taskId,
        path: document.materializeAs,
        body: renderTemplateBody(document.body, action.title),
        packageSlug: action.slug
      })),
      ...(module ? [{
        taskId,
        path: "module.md",
        body: renderModuleSelection(module),
        packageSlug: action.slug
      }] : [])
    ];
    if (action.dryRun) {
      return {
        ok: true,
        command: "new-task",
        taskId,
        slug: action.slug,
        status: "planned",
        packagePath: path.relative(rootDir, createTaskPackagePath(rootDir, taskId, action.slug)).split(path.sep).join("/"),
        preset: publicPresetSummary(preset),
        module: module ? { key: module.key, title: module.title } : undefined,
        generated: writes.map((write) => write.path),
        report: {
          schema: "preset-task-create-report/v1",
          dryRun: true,
          vertical,
          preset: preset.manifest.id,
          profile: materialized.profile.id,
          module: module ? { key: module.key, title: module.title, scopes: module.scopes } : undefined,
          longRunning: action.longRunning,
          templateCount: materialized.documents.length
        }
      } satisfies CliResult;
    }
    const coordinator = makeLocalWriteCoordinator({ rootDir, actor: { kind: "agent", id: "local-lifecycle" } });
    const opId = `${Date.now()}-${stablePayloadHash({ kind: "package_create", writes }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      taskId,
      kind: "package_create",
      payload: { writes }
    });
    yield* coordinator.flush("explicit");
    if (registeredModule) {
      const registry = readModules(rootDir);
      writeModules(rootDir, {
        modules: registry.modules.some((candidate) => candidate.key === registeredModule.key)
          ? registry.modules.map((candidate) => candidate.key === registeredModule.key ? registeredModule : candidate)
          : [...registry.modules, registeredModule]
      });
    }

    return {
      ok: true,
      command: "new-task",
      taskId,
      slug: action.slug,
      status: "planned",
      packagePath: path.relative(rootDir, createTaskPackagePath(rootDir, taskId, action.slug)).split(path.sep).join("/"),
      preset: publicPresetSummary(preset),
      module: module ? { key: module.key, title: module.title } : undefined,
      generated: writes.map((write) => write.path),
      report: {
        schema: "preset-task-create-report/v1",
        vertical,
        preset: preset.manifest.id,
        profile: materialized.profile.id,
        module: module ? { key: module.key, title: module.title, scopes: module.scopes } : undefined,
        templateCount: materialized.documents.length
      }
    } satisfies CliResult;
  });
}

function renderModuleSelection(module: { readonly key: string; readonly title: string; readonly scopes: ReadonlyArray<string> }): string {
  return [
    "# Module Selection",
    "",
    `Module key: ${module.key}`,
    `Module title: ${module.title}`,
    "",
    "## Scopes",
    "",
    ...module.scopes.map((scope) => `- ${scope}`),
    "",
    "This file records module selection only. It does not create parent/child, DAG, or relation semantics.",
    ""
  ].join("\n");
}

function renderTemplateBody(body: string, title: string): string {
  return body.replace(/\{\{title\}\}/gu, title);
}

function stablePayloadHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
