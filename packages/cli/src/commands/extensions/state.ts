import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  moduleEntityId,
  PresetManifestSchema,
  planTemplateMaterialization,
  validateExtensionInputShape,
  validatePresetManifests,
  type ExtensionValidationIssue,
  type WriteError,
  type MaterializedTemplatePlan
} from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../../kernel/src/index.ts";
import { stablePayloadHash, writeCoordinatedPayload } from "../../../../kernel/src/write-coordination/write-helpers.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import {
  bundledTemplateCatalog,
  bundledVerticalDefinition,
  loadBundledPresetManifestEntries
} from "./bundled.ts";
import { writeModuleRegistryView } from "./module-registry-view.ts";
import { presetScriptAuthorizationRequiredResult } from "./preset-evidence.ts";
import { runScriptEntrypoint, scriptCliResult } from "./preset-script-runner.ts";
import { resolveTemplateCatalogBody } from "./template-catalog-loader.ts";

type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;

export interface ResolvedPreset {
  readonly manifest: PresetManifest;
  readonly layer: "project" | "user" | "builtin";
  readonly sourcePath: string;
}

export interface InvalidPreset {
  readonly id: string;
  readonly directoryId?: string;
  readonly layer: "project" | "user";
  readonly sourcePath: string;
  readonly issues: ReadonlyArray<ExtensionValidationIssue>;
}

export type PresetResolutionEntry = ResolvedPreset | InvalidPreset;

export interface ModuleRegistry {
  readonly modules: ReadonlyArray<ModuleRecord>;
}

export interface ModuleRecord {
  readonly key: string;
  readonly title: string;
  readonly prefix?: string;
  readonly status: string;
  readonly branch?: string;
  readonly owner?: string;
  readonly currentStep?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly shared?: ReadonlyArray<string>;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly state: string }>;
}

const reservedMaterializedPaths = new Set(["INDEX.md", "module.md", "relations.json", "relations.md"]);

export function isInvalidPreset(entry: PresetResolutionEntry): entry is InvalidPreset {
  return "issues" in entry;
}

export function isResolvedPreset(entry: PresetResolutionEntry): entry is ResolvedPreset {
  return !isInvalidPreset(entry);
}

export function discoverPresetEntries(rootInput: HarnessLayoutInput): ReadonlyArray<PresetResolutionEntry> {
  const byId = new Map<string, PresetResolutionEntry>();
  for (const entry of loadBundledPresetManifestEntries()) {
    byId.set(entry.manifest.id, { manifest: entry.manifest, layer: "builtin", sourcePath: entry.sourcePath });
  }
  for (const layer of ["user", "project"] as const) {
    for (const preset of readLayerPresetEntries(rootInput, layer)) {
      byId.set(presetEntryId(preset), preset);
    }
  }
  return [...byId.values()].sort((left, right) => presetEntryId(left).localeCompare(presetEntryId(right)));
}

export function discoverPresets(rootInput: HarnessLayoutInput): ReadonlyArray<ResolvedPreset> {
  return discoverPresetEntries(rootInput).filter(isResolvedPreset);
}

export function resolvePresetEntry(rootInput: HarnessLayoutInput, presetId: string): PresetResolutionEntry | undefined {
  return discoverPresetEntries(rootInput).find((preset) => presetEntryId(preset) === presetId);
}

export function resolvePreset(rootInput: HarnessLayoutInput, presetId: string): ResolvedPreset | undefined {
  const entry = resolvePresetEntry(rootInput, presetId);
  return entry && !isInvalidPreset(entry) ? entry : undefined;
}

export function publicPresetSummary(preset: ResolvedPreset): Record<string, unknown> {
  const validation = validatePresetManifestForUse(preset.manifest);
  return {
    id: preset.manifest.id,
    title: preset.manifest.title,
    version: preset.manifest.version,
    kind: preset.manifest.kind ?? "template-content",
    vertical: preset.manifest.vertical,
    defaultProfile: preset.manifest.defaultProfile,
    entrypoints: Object.keys(preset.manifest.entrypoints ?? {}).sort(),
    layer: preset.layer,
    sourcePath: safePresetSourcePath(preset.sourcePath),
    valid: validation.ok,
    issueCount: validation.issues.length
  };
}

export function publicPresetEntrySummary(entry: PresetResolutionEntry): Record<string, unknown> {
  if (!isInvalidPreset(entry)) return publicPresetSummary(entry);
  return {
    id: entry.id,
    layer: entry.layer,
    sourcePath: safePresetSourcePath(entry.sourcePath),
    valid: false,
    issueCount: entry.issues.length
  };
}

function safePresetSourcePath(sourcePath: string): string {
  return sourcePath.startsWith("builtin:") ? sourcePath : sourcePath.split(path.sep).slice(-3).join("/");
}

function readLayerPresetEntries(rootInput: HarnessLayoutInput, layer: "project" | "user"): ReadonlyArray<PresetResolutionEntry> {
  const layerRoot = presetLayerRoot(rootInput, layer);
  if (!existsSync(layerRoot)) return [];
  return readdirSync(layerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): ReadonlyArray<PresetResolutionEntry> => {
      const presetPath = path.join(layerRoot, entry.name, "preset.json");
      if (!existsSync(presetPath)) {
        return [{
          id: entry.name,
          layer,
          sourcePath: presetPath,
          issues: [extensionIssue("preset_path_id_mismatch", `Preset directory ${entry.name} is missing preset.json.`, "preset.json")]
        }];
      }
      const decoded = decodePresetManifestFileResult(presetPath);
      if (decoded.ok && decoded.value.id !== entry.name) {
        const invalid = {
          layer,
          sourcePath: presetPath,
          issues: [extensionIssue("preset_path_id_mismatch", `Preset manifest id ${decoded.value.id} must match directory ${entry.name}.`, "id")]
        };
        return [
          { ...invalid, id: entry.name, directoryId: entry.name },
          { ...invalid, id: decoded.value.id, directoryId: entry.name }
        ];
      }
      return decoded.ok
        ? [{ manifest: decoded.value, layer, sourcePath: presetPath }]
        : [{ id: entry.name, layer, sourcePath: presetPath, issues: decoded.issues }];
    });
}

export function loadBundledPresetManifests(): ReadonlyArray<PresetManifest> {
  return loadBundledPresetManifestEntries().map((entry) => entry.manifest);
}

export function validatePresetManifestForUse(manifest: PresetManifest): {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<ExtensionValidationIssue>;
} {
  const base = validatePresetManifests([manifest], { kernelVersion: "1.0.0" });
  const additiveIssues = validateAdditiveSoftwareCodingPreset(manifest);
  return {
    ok: base.ok && additiveIssues.length === 0,
    issues: [...base.issues, ...additiveIssues]
  };
}

export function selectPresetProfile(
  manifest: PresetManifest,
  profileId?: string
): PresetManifest["profiles"][number] | undefined {
  return manifest.profiles.find((profile) => profile.id === (profileId ?? manifest.defaultProfile));
}

export function materializePresetTaskDocuments(
  manifest: PresetManifest,
  options: {
    readonly profileId?: string;
    readonly locale: "zh-CN" | "en-US";
  }
): {
  readonly ok: boolean;
  readonly profile?: PresetManifest["profiles"][number];
  readonly documents: ReadonlyArray<MaterializedTemplatePlan>;
  readonly issues: ReadonlyArray<ExtensionValidationIssue>;
} {
  const profile = selectPresetProfile(manifest, options.profileId);
  if (!profile) {
    return {
      ok: false,
      documents: [],
      issues: [extensionIssue("missing_profile", `Preset profile ${options.profileId ?? manifest.defaultProfile} is not declared.`, "profile")]
    };
  }
  const validation = validatePresetManifestForUse(manifest);
  if (!validation.ok) {
    return { ok: false, profile, documents: [], issues: validation.issues };
  }
  const catalog = requireBundledTemplateCatalog();
  const materialized = planTemplateMaterialization({
    catalog,
    locale: options.locale,
    resolveBody: resolveTemplateCatalogBody(catalog),
    selections: combineVerticalAndPresetSelections(profile.templateSelections)
  });
  return {
    ok: materialized.ok,
    profile,
    documents: materialized.documents,
    issues: materialized.issues
  };
}

export function readPresetManifestFromSource(sourcePath: string): PresetManifest {
  const decoded = readPresetManifestFromSourceResult(sourcePath);
  if (!decoded.ok) {
    throw new Error("preset manifest shape invalid");
  }
  return decoded.value;
}

export function readPresetManifestFromSourceResult(sourcePath: string): { readonly ok: true; readonly value: PresetManifest } | { readonly ok: false; readonly issues: ReadonlyArray<ExtensionValidationIssue> } {
  const resolved = path.resolve(sourcePath);
  const presetPath = existsSync(path.join(resolved, "preset.json")) ? path.join(resolved, "preset.json") : resolved;
  return decodePresetManifestFileResult(presetPath);
}

function decodePresetManifestFileResult(presetPath: string): { readonly ok: true; readonly value: PresetManifest } | { readonly ok: false; readonly issues: ReadonlyArray<ExtensionValidationIssue> } {
  try {
    const raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
    const shape = validateExtensionInputShape("preset-manifest", raw);
    if (!shape.ok) {
      return { ok: false, issues: shape.issues };
    }
    return { ok: true, value: Schema.decodeUnknownSync(PresetManifestSchema)(raw) };
  } catch (error) {
    return {
      ok: false,
      issues: [extensionIssue("unknown_extension_field", error instanceof Error ? error.message : "Preset manifest failed validation.", "$")]
    };
  }
}

function presetLayerRoot(rootInput: HarnessLayoutInput, layer: "project" | "user"): string {
  const layout = resolveHarnessLayout(rootInput);
  return layer === "project"
    ? path.join(layout.localRoot, "presets")
    : path.join(layout.localRoot, "user-presets");
}

export function presetManifestPath(rootInput: HarnessLayoutInput, layer: "project" | "user", presetId: string): string {
  validateRegistryKey(presetId, "preset");
  return path.join(presetLayerRoot(rootInput, layer), presetId, "preset.json");
}

export function runPresetEntrypoint(
  rootInput: HarnessLayoutInput,
  presetId: string,
  entrypoint: string,
  taskId: string,
  commandName: "preset-run" | "preset-action",
  allowScripts = false,
  inputs: Record<string, string> = {}
): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const preset = resolvePresetEntry(rootInput, presetId);
  if (!preset) return presetNotFound("preset-run", presetId);
  if (isInvalidPreset(preset)) {
    return {
      ok: false,
      command: commandName,
      preset: { id: preset.id, layer: preset.layer, valid: false },
      issues: preset.issues,
      error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
    };
  }
  const validation = validatePresetManifestForUse(preset.manifest);
  if (!validation.ok) {
    return {
      ok: false,
      command: commandName,
      preset: publicPresetSummary(preset),
      issues: validation.issues,
      error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
    };
  }
  validateRegistryKey(taskId, "task");
  const evidenceDir = path.join(layout.localRoot, "evidence", "presets", presetId, timestampForPath());
  mkdirSync(evidenceDir, { recursive: true });
  const generated: string[] = [];
  const declaredEntrypoint = preset.manifest.entrypoints?.[entrypoint];
  if (declaredEntrypoint?.type === "script") {
    if (!allowScripts) {
      return presetScriptAuthorizationRequiredResult({
        rootDir,
        evidenceDir,
        commandName,
        presetSummary: publicPresetSummary(preset),
        presetId,
        layer: preset.layer,
        taskId,
        entrypoint
      });
    }
    const presetSummary = publicPresetSummary(preset);
    const scriptResult = runScriptEntrypoint(rootInput, preset, presetSummary, declaredEntrypoint, entrypoint, taskId, evidenceDir, commandName, inputs);
    if (!scriptResult.ok) return scriptResult.result;
    generated.push(...scriptResult.generated);
    if (scriptResult.scriptedResult) {
      return scriptCliResult({
        rootDir,
        evidenceDir,
        commandName,
        preset: presetSummary,
        generated,
        scriptedResult: scriptResult.scriptedResult
      });
    }
  } else if (preset.manifest.schema === "preset-manifest/v1" && entrypoint === "scaffold") {
    const outputPath = path.join(layout.generatedRoot, "preset-scaffold", taskId, `${presetId}.md`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `# ${preset.manifest.title}\n\nTask: ${taskId}\n`, "utf8");
    generated.push(path.relative(rootDir, outputPath).split(path.sep).join("/"));
  } else {
    return {
      ok: false,
      command: commandName,
      preset: publicPresetSummary(preset),
      error: cliError(CliErrorCode.PresetActionForbidden, `Preset ${presetId} does not declare action ${entrypoint}.`)
    };
  }
  const evidence = {
    schema: "preset-evidence/v1",
    presetId,
    layer: preset.layer,
    taskId,
    entrypoint,
    generated,
    ok: true,
    scriptAuthorized: declaredEntrypoint?.type === "script" ? allowScripts : false
  };
  writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  return {
    ok: true,
    command: commandName,
    preset: publicPresetSummary(preset),
    evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
    generated,
    report: evidence
  };
}

export function readModules(rootInput: HarnessLayoutInput): ModuleRegistry {
  const registryPath = modulesRegistryPath(rootInput);
  if (!existsSync(registryPath)) return { modules: [] };
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { readonly modules?: ReadonlyArray<ModuleRecord> };
  return { modules: parsed.modules ?? [] };
}

export function writeModules(rootInput: HarnessLayoutInput, registry: ModuleRegistry): void {
  writeModuleRegistryView(rootInput, registry);
}

export function writeModulesCoordinated(
  rootInput: HarnessLayoutInput,
  coordinator: WriteCoordinator,
  input: {
    readonly registry: ModuleRegistry;
    readonly moduleKey: string;
    readonly operation: "register" | "unregister" | "step";
  }
): Effect.Effect<void, WriteError> {
  return writeCoordinatedPayload(coordinator, stablePayloadHash, {
    entityId: moduleEntityId(input.moduleKey),
    kind: "module_registry_write",
    payload: {
      operation: input.operation,
      registry: { schema: "module-registry/v1", modules: input.registry.modules }
    }
  }).pipe(
    Effect.tap(() => Effect.sync(() => writeModules(rootInput, input.registry)))
  );
}

function modulesRegistryPath(rootInput: HarnessLayoutInput): string {
  return path.join(resolveHarnessLayout(rootInput).authoredRoot, "modules.json");
}

export function presetNotFound(command: string, presetId: string): CliResult {
  return {
    ok: false,
    command,
    preset: { id: presetId },
    error: cliError(CliErrorCode.PresetNotFound, `Preset ${presetId} was not found.`)
  };
}

export function moduleNotFound(command: string, moduleKey: string): CliResult {
  return {
    ok: false,
    command,
    module: { key: moduleKey },
    error: cliError(CliErrorCode.ModuleNotFound, `Module ${moduleKey} was not found.`)
  };
}

export class InvalidRegistryKeyError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`Invalid ${label} key.`);
    this.name = "InvalidRegistryKeyError";
    this.label = label;
  }
}

function validateRegistryKey(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new InvalidRegistryKeyError(label);
  }
}

function timestampForPath(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function validateAdditiveSoftwareCodingPreset(manifest: PresetManifest): ReadonlyArray<ExtensionValidationIssue> {
  const issues: ExtensionValidationIssue[] = [];
  const vertical = requireBundledVerticalDefinition();
  const catalog = requireBundledTemplateCatalog();
  if (manifest.vertical !== vertical.id) {
    issues.push(extensionIssue("custom_vertical_forbidden", "P08 only allows software/coding preset overrides; custom vertical exposure is gated by P10/P11.", "vertical"));
  }

  const requiredSelections = verticalTaskTemplateSelections(vertical);
  const requiredBySlot = new Map(requiredSelections.map((selection) => [selection.slot, selection]));
  const requiredByPath = new Map(requiredSelections.map((selection) => [selection.materializeAs, selection]));

  for (const [profileIndex, profile] of manifest.profiles.entries()) {
    const materializedPaths = new Set<string>();
    const materialized = planTemplateMaterialization({
      catalog,
      locale: "zh-CN",
      resolveBody: resolveTemplateCatalogBody(catalog),
      selections: profile.templateSelections
    });
    issues.push(...materialized.issues);

    for (const [selectionIndex, selection] of profile.templateSelections.entries()) {
      const path = `profiles[${profileIndex}].templateSelections[${selectionIndex}]`;
      try {
        normalizeRelativeDocumentPath(selection.materializeAs);
      } catch (error) {
        issues.push(extensionIssue("invalid_materialized_path", error instanceof Error ? error.message : `Invalid materialized path ${selection.materializeAs}.`, path));
      }
      if (reservedMaterializedPaths.has(selection.materializeAs)) {
        issues.push(extensionIssue("reserved_materialized_path", `Preset ${manifest.id} cannot materialize reserved task package path ${selection.materializeAs}.`, path));
      }
      if (materializedPaths.has(selection.materializeAs)) {
        issues.push(extensionIssue("duplicate_materialized_path", `Preset ${manifest.id} has duplicate materialized path ${selection.materializeAs}.`, path));
      }
      materializedPaths.add(selection.materializeAs);
      const requiredSlot = requiredBySlot.get(selection.slot);
      if (requiredSlot && (requiredSlot.materializeAs !== selection.materializeAs || (requiredSlot.templateRef !== selection.templateRef && !allowsRequiredTemplateOverride(manifest, selection)))) {
        issues.push(extensionIssue("preset_required_template_conflict", `Preset ${manifest.id} cannot replace vertical-required slot ${selection.slot}.`, path));
      }
      const requiredPath = requiredByPath.get(selection.materializeAs);
      if (requiredPath && (requiredPath.slot !== selection.slot || (requiredPath.templateRef !== selection.templateRef && !allowsRequiredTemplateOverride(manifest, selection)))) {
        issues.push(extensionIssue("preset_required_template_conflict", `Preset ${manifest.id} cannot replace vertical-required document ${selection.materializeAs}.`, path));
      }
    }
  }

  return issues;
}

function allowsRequiredTemplateOverride(
  manifest: PresetManifest,
  selection: PresetManifest["profiles"][number]["templateSelections"][number]
): boolean {
  return manifest.id === "create-milestone" &&
    selection.slot === "task.plan" &&
    selection.materializeAs === "task_plan.md" &&
    selection.templateRef === "template://planning/milestone-task-plan@1";
}

function combineVerticalAndPresetSelections(
  presetSelections: ReadonlyArray<PresetManifest["profiles"][number]["templateSelections"][number]>
): PresetManifest["profiles"][number]["templateSelections"] {
  const byPath = new Map<string, PresetManifest["profiles"][number]["templateSelections"][number]>();
  for (const selection of verticalTaskTemplateSelections(requireBundledVerticalDefinition())) {
    byPath.set(selection.materializeAs, selection);
  }
  for (const selection of presetSelections) {
    const existing = byPath.get(selection.materializeAs);
    if (existing && existing.slot === selection.slot && existing.templateRef === selection.templateRef) continue;
    byPath.set(selection.materializeAs, selection);
  }
  return [...byPath.values()];
}

function verticalTaskTemplateSelections(
  vertical: ReturnType<typeof requireBundledVerticalDefinition>
): PresetManifest["profiles"][number]["templateSelections"] {
  return vertical.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections ?? vertical.templateSelections;
}

function requireBundledTemplateCatalog() {
  const catalog = bundledTemplateCatalog();
  if (!catalog) throw new Error("bundled template catalog missing");
  return catalog;
}

function requireBundledVerticalDefinition() {
  const vertical = bundledVerticalDefinition();
  if (!vertical) throw new Error("bundled vertical definition missing");
  return vertical;
}

function extensionIssue(code: ExtensionValidationIssue["code"], message: string, pathValue: string): ExtensionValidationIssue {
  return { code, message, path: pathValue };
}

function presetEntryId(entry: PresetResolutionEntry): string {
  return isInvalidPreset(entry) ? entry.id : entry.manifest.id;
}
