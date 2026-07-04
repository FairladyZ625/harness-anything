import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { makeLocalWriteCoordinator } from "../../../adapters/local/src/index.ts";
import { resolveTaskCreatedBy } from "../../../adapters/local/src/created-by.ts";
import { indexPath, makeIndex, renderIndex, validateGeneratedTaskId, validateTaskId } from "../../../adapters/local/src/task-index.ts";
import { bindCreateProvenance, type ProvenanceBindingOptions } from "../../../application/src/index.ts";
import { taskEntityId, type EngineError, type WriteError } from "../../../kernel/src/domain/index.ts";
import { stablePayloadHash } from "../../../kernel/src/integrity/stable-hash.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/layout/index.ts";
import { createTaskPackagePath, generateTaskId, resolveHarnessLayout } from "../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { buildDerivedDocmapReadSet, renderDocmapReadSetMarkdown } from "./core/docmap-generate.ts";
import { isInvalidPreset, materializePresetTaskDocuments, presetNotFound, publicPresetSummary, readModules, resolvePresetEntry, writeModulesCoordinated } from "./extensions/state.ts";
import { customVerticalGateResult, type ProjectHarnessSettings } from "./settings.ts";

type NewTaskAction = Extract<ParsedCommand["action"], { readonly kind: "new-task" }>;

export function shouldUsePresetAwareNewTask(action: NewTaskAction): boolean {
  return Boolean(action.vertical || action.preset || action.profile || action.moduleKey || action.registerModule || action.longRunning || action.dryRun || action.locale);
}

export function runNewTaskWithPreset(
  rootInput: HarnessLayoutInput,
  action: NewTaskAction,
  settings?: ProjectHarnessSettings,
  provenanceOptions: ProvenanceBindingOptions = {}
): Effect.Effect<CliResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const rootDir = resolveHarnessLayout(rootInput).rootDir;
    const vertical = action.vertical ?? settings?.defaultVertical ?? "software/coding";
    if (vertical !== "software/coding") {
      return customVerticalGateResult(rootInput, "new-task", settings);
    }

    let presetId = action.preset ?? settings?.defaultPreset ?? "standard-task";
    if (action.longRunning) presetId = "long-running-task";
    if (presetId === "module" && !action.moduleKey) {
      return {
        ok: false,
        command: "new-task",
        preset: { id: presetId },
        error: cliError(CliErrorCode.MissingModule, "Use task create --preset module --module <key>.")
      } satisfies CliResult;
    }
    const preset = resolvePresetEntry(rootInput, presetId);
    if (!preset) return presetNotFound("new-task", presetId);
    if (isInvalidPreset(preset)) {
      return {
        ok: false,
        command: "new-task",
        preset: { id: preset.id, layer: preset.layer, valid: false },
        issues: preset.issues,
        error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
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
        error: cliError(CliErrorCode.PresetMaterializationFailed, "Preset-selected templates could not be materialized.")
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
      : action.moduleKey ? readModules(rootInput).modules.find((candidate) => candidate.key === action.moduleKey && candidate.status !== "unregistered") : undefined;
    if (action.moduleKey && !module) {
      return {
        ok: false,
        command: "new-task",
        module: { key: action.moduleKey },
        error: cliError(CliErrorCode.ModuleNotFound, `Module ${action.moduleKey} was not found.`)
      } satisfies CliResult;
    }

    const taskId = action.taskId ?? generateTaskId();
    if (!action.allowManualId) {
      const error = validateGeneratedTaskId(taskId);
      if (error) return yield* Effect.fail(error);
    } else {
      validateTaskId(taskId);
    }
    if (existsSync(indexPath(rootInput, taskId))) {
      return yield* Effect.fail({ _tag: "TaskAlreadyExists", taskId } satisfies EngineError);
    }

    const createdAt = new Date().toISOString();
    const docmap = resolveTaskReadSet(rootInput, action.moduleKey);
    const readSetCount = docmap.readSet.mandatory.length + docmap.readSet.recommended.length;
    const readSetWrite = readSetCount > 0
      ? [{
        taskId,
        path: "read_set.md",
        body: renderDocmapReadSetMarkdown(docmap.readSet, {
          title: action.title,
          moduleKey: action.moduleKey,
          source: docmap.source
        }),
        packageSlug: action.slug
      }]
      : [];
    const generated = [
      "INDEX.md",
      ...materialized.documents.map((document) => document.materializeAs),
      ...(module ? ["module.md"] : []),
      ...readSetWrite.map((write) => write.path)
    ];
    if (action.dryRun) {
      return {
        ok: true,
        command: "new-task",
        taskId,
        slug: action.slug,
        status: "planned",
        packagePath: path.relative(rootDir, createTaskPackagePath(rootInput, taskId, action.slug)).split(path.sep).join("/"),
        preset: publicPresetSummary(preset),
        module: module ? { key: module.key, title: module.title } : undefined,
        generated,
        report: {
          schema: "preset-task-create-report/v1",
          dryRun: true,
          vertical,
          preset: preset.manifest.id,
          profile: materialized.profile.id,
          module: module ? { key: module.key, title: module.title, scopes: module.scopes } : undefined,
          longRunning: action.longRunning,
          templateCount: materialized.documents.length,
          docmap: {
            source: docmap.source,
            readSetCount,
            mandatory: docmap.readSet.mandatory.length,
            recommended: docmap.readSet.recommended.length
          }
        }
      } satisfies CliResult;
    }
    const provenance = yield* bindCreateProvenance(provenanceOptions, createdAt).pipe(
      Effect.mapError((error) => ({ _tag: "WriteRejected", taskId, reason: error.reason } satisfies WriteError))
    );
    const index = makeIndex({
      taskId,
      title: action.title,
      status: "planned",
      bindingCreatedAt: createdAt,
      vertical,
      preset: preset.manifest.id,
      profile: materialized.profile.id,
      provenance: provenance ? [provenance] : [{
        runtime: "human",
        sessionId: `human-cli-${Date.parse(createdAt)}`,
        boundAt: createdAt
      }],
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
      }] : []),
      ...readSetWrite
    ];
    const coordinator = makeLocalWriteCoordinator({
      rootDir,
      layoutOverrides: layoutOverridesFromInput(rootInput),
      actor: { kind: "agent", id: "local-lifecycle" }
    });
    const opId = `${Date.now()}-${stablePayloadHash({ kind: "package_create", writes }).slice(0, 16)}`;
    yield* coordinator.enqueue({
      opId,
      entityId: taskEntityId(taskId),
      kind: "package_create",
      payload: { writes }
    });
    yield* coordinator.flush("explicit");
    if (registeredModule) {
      const registry = readModules(rootInput);
      yield* writeModulesCoordinated(rootInput, coordinator, {
        moduleKey: registeredModule.key,
        operation: "register",
        registry: {
          modules: registry.modules.some((candidate) => candidate.key === registeredModule.key)
          ? registry.modules.map((candidate) => candidate.key === registeredModule.key ? registeredModule : candidate)
          : [...registry.modules, registeredModule]
        }
      });
    }

    return {
      ok: true,
      command: "new-task",
      taskId,
      slug: action.slug,
      status: "planned",
      packagePath: path.relative(rootDir, createTaskPackagePath(rootInput, taskId, action.slug)).split(path.sep).join("/"),
      preset: publicPresetSummary(preset),
      module: module ? { key: module.key, title: module.title } : undefined,
      generated: writes.map((write) => write.path),
      report: {
        schema: "preset-task-create-report/v1",
        vertical,
        preset: preset.manifest.id,
        profile: materialized.profile.id,
        module: module ? { key: module.key, title: module.title, scopes: module.scopes } : undefined,
        templateCount: materialized.documents.length,
        docmap: {
          source: docmap.source,
          readSetCount,
          mandatory: docmap.readSet.mandatory.length,
          recommended: docmap.readSet.recommended.length
        }
      }
    } satisfies CliResult;
  });
}

function resolveTaskReadSet(
  rootInput: HarnessLayoutInput,
  moduleKey: string | undefined
): ReturnType<typeof buildDerivedDocmapReadSet> {
  return buildDerivedDocmapReadSet(rootInput, moduleKey);
}

function layoutOverridesFromInput(rootInput: HarnessLayoutInput): HarnessLayoutOverrides | undefined {
  return typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
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
