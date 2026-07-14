import { existsSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { assertValidParentBinding, indexPath, makeIndex, renderIndex, validateGeneratedTaskId, validateTaskId } from "../../../adapters/local/src/task-index.ts";
import { bindCreateProvenance, compileTaskContractSnapshot, type ProvenanceBindingOptions } from "../../../application/src/index.ts";
import {
  createTaskPackagePath,
  generateTaskId,
  resolveHarnessLayout,
  stablePayloadHash,
  taskEntityId,
  type EngineError,
  type ExtensionValidationIssue,
  type HarnessLayoutInput,
  type MaterializedTemplatePlan,
  type OperationalActor,
  type WriteCoordinator,
  type WriteError
} from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { bundledTemplateCatalog } from "./extensions/bundled.ts";
import { isInvalidPreset, materializePresetTaskDocuments, presetNotFound, publicPresetSummary, readModules, resolvePresetEntry, writeModulesCoordinated, type ResolvedPreset } from "./extensions/state.ts";
import { customVerticalGateResult, type ProjectHarnessSettings } from "./settings.ts";

type NewTaskAction = Extract<ParsedCommand["action"], { readonly kind: "new-task" }>;

interface PresetTaskMaterializationInput {
  readonly command: string;
  readonly vertical: string;
  readonly presetId: string;
  readonly profileId?: string;
  readonly locale: "zh-CN" | "en-US";
}

interface PresetTaskMaterializationResult {
  readonly vertical: string;
  readonly preset: ResolvedPreset;
  readonly materialized: {
    readonly ok: true;
    readonly profile: NonNullable<ReturnType<typeof materializePresetTaskDocuments>["profile"]>;
    readonly documents: ReadonlyArray<MaterializedTemplatePlan>;
    readonly issues: ReadonlyArray<ExtensionValidationIssue>;
  };
}

export function shouldUsePresetAwareNewTask(action: NewTaskAction): boolean {
  return Boolean(
    action.vertical
    || action.preset
    || action.profile
    || action.moduleKey
    || action.registerModule
    || action.longRunning
    || action.dryRun
    || action.locale
  );
}

export function runNewTaskWithPreset(
  rootInput: HarnessLayoutInput,
  action: NewTaskAction,
  settings?: ProjectHarnessSettings,
  provenanceOptions: ProvenanceBindingOptions = {},
  makeWriteCoordinator?: (actor: OperationalActor) => WriteCoordinator
): Effect.Effect<CliResult, EngineError | WriteError> {
  return Effect.gen(function* () {
    const rootDir = resolveHarnessLayout(rootInput).rootDir;
    const vertical = action.vertical ?? settings?.defaultVertical ?? "software/coding";

    const presetId = action.preset ?? (action.longRunning ? "long-running-task" : settings?.defaultPreset ?? "standard-task");
    if (presetId === "module" && !action.moduleKey) {
      return {
        ok: false,
        command: "new-task",
        preset: { id: presetId },
        error: cliError(CliErrorCode.MissingModule, "Use task create --preset module --module <key>.")
      } satisfies CliResult;
    }
    const scaffold = materializePresetTaskScaffold(rootInput, {
      command: "new-task",
      vertical,
      presetId,
      profileId: action.profile ?? settings?.defaultProfile,
      locale: action.locale ?? settings?.locale ?? "zh-CN"
    }, settings);
    if (!scaffold.ok) return scaffold.result;
    const { materialized, preset } = scaffold;

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
    if (action.parent) {
      const parentValidation = assertValidParentBinding(rootInput, taskId, action.parent);
      if (!parentValidation.ok) return yield* Effect.fail({ _tag: "WriteRejected", taskId, reason: parentValidation.reason } satisfies WriteError);
    }

    const createdAt = new Date().toISOString();
    const catalog = bundledTemplateCatalog(vertical);
    if (!catalog) {
      return {
        ok: false,
        command: "new-task",
        preset: publicPresetSummary(preset),
        error: cliError(CliErrorCode.TemplateCatalogInvalid, `Template catalog is not resolvable for vertical ${vertical}.`)
      } satisfies CliResult;
    }
    const contractSnapshot = compileTaskContractSnapshot({
      vertical,
      preset: preset.manifest,
      profileId: materialized.profile.id,
      catalog,
      documents: materialized.documents,
      capturedAt: createdAt,
      capturedBy: "task-create"
    });
    const generated = [
      "INDEX.md",
      "task-contract.json",
      ...materialized.documents.map((document) => document.materializeAs),
      ...(module ? ["module.md"] : [])
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
          templateCount: materialized.documents.length
        }
      } satisfies CliResult;
    }
    const provenance = yield* bindCreateProvenance(provenanceOptions, createdAt).pipe(
      Effect.mapError((error) => ({ _tag: "WriteRejected", taskId, reason: error.reason } satisfies WriteError))
    );
    const index = makeIndex({
      taskId,
      title: action.title,
      parent: action.parent,
      status: "planned",
      bindingCreatedAt: createdAt,
      workKind: action.workKind,
      riskTier: action.riskTier,
      urgency: action.urgency,
      vertical,
      preset: preset.manifest.id,
      profile: materialized.profile.id,
      provenance: provenance ? [provenance] : [{
        runtime: "human",
        sessionId: `human-cli-${Date.parse(createdAt)}`,
        boundAt: createdAt
      }]
    }, stablePayloadHash);
    const writes = [
      { taskId, path: "INDEX.md", body: renderIndex(index), packageSlug: action.slug },
      { taskId, path: "task-contract.json", body: `${JSON.stringify(contractSnapshot, null, 2)}\n`, packageSlug: action.slug },
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
    const coordinator = makeWriteCoordinator?.({ scope: "operational", kind: "agent", id: "preset-task" });
    if (!coordinator) return yield* Effect.fail({ _tag: "JournalUnavailable", cause: new Error("write coordinator factory is required") } satisfies WriteError);
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
        templateCount: materialized.documents.length
      }
    } satisfies CliResult;
  });
}

export function materializePresetTaskScaffold(
  rootInput: HarnessLayoutInput,
  input: PresetTaskMaterializationInput,
  settings?: ProjectHarnessSettings
): { readonly ok: true } & PresetTaskMaterializationResult | { readonly ok: false; readonly result: CliResult } {
  if (input.vertical !== "software/coding") {
    return { ok: false, result: customVerticalGateResult(rootInput, input.command, settings) };
  }
  const preset = resolvePresetEntry(rootInput, input.presetId, input.vertical);
  if (!preset) return { ok: false, result: presetNotFound(input.command, input.presetId) };
  if (isInvalidPreset(preset)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: input.command,
        preset: { id: preset.id, layer: preset.layer, valid: false },
        issues: preset.issues,
        error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
      } satisfies CliResult
    };
  }

  const materialized = materializePresetTaskDocuments(preset.manifest, {
    profileId: input.profileId,
    locale: input.locale
  });
  if (!materialized.ok || !materialized.profile) {
    return {
      ok: false,
      result: {
        ok: false,
        command: input.command,
        preset: publicPresetSummary(preset),
        issues: materialized.issues,
        error: cliError(CliErrorCode.PresetMaterializationFailed, "Preset-selected templates could not be materialized.")
      } satisfies CliResult
    };
  }

  return {
    ok: true,
    vertical: input.vertical,
    preset,
    materialized: {
      ok: true,
      profile: materialized.profile,
      documents: materialized.documents,
      issues: materialized.issues
    }
  };
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

export function renderTemplateBody(body: string, title: string): string {
  return body.replace(/\{\{title\}\}/gu, title);
}
