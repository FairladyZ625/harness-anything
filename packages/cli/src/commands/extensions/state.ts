import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import {
  PresetManifestSchema,
  planTemplateMaterialization,
  validateExtensionInputShape,
  validatePresetManifests,
  type ExtensionValidationIssue,
  type MaterializedTemplatePlan
} from "../../../../kernel/src/index.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import type { CliResult } from "../../cli/types.ts";
import {
  bundledSoftwareCodingTemplateCatalog,
  bundledSoftwareCodingVerticalDefinition,
  bundledTaskTemplateSelections
} from "./bundled.ts";

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

interface ModuleRegistry {
  readonly modules: ReadonlyArray<ModuleRecord>;
}

interface ModuleRecord {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly scopes: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly state: string }>;
}

const bundledPresetIds = [
  "standard-task",
  "module",
  "legacy-migration",
  "lesson-sedimentation",
  "version-upgrade",
  "publish-standard",
  "release-closeout"
] as const;

const reservedMaterializedPaths = new Set(["INDEX.md", "module.md", "relations.json", "relations.md"]);

export function isInvalidPreset(entry: PresetResolutionEntry): entry is InvalidPreset {
  return "issues" in entry;
}

export function isResolvedPreset(entry: PresetResolutionEntry): entry is ResolvedPreset {
  return !isInvalidPreset(entry);
}

export function discoverPresetEntries(rootDir: string): ReadonlyArray<PresetResolutionEntry> {
  const byId = new Map<string, PresetResolutionEntry>();
  for (const manifest of bundledPresetManifests()) {
    byId.set(manifest.id, { manifest, layer: "builtin", sourcePath: `builtin:${manifest.id}` });
  }
  for (const layer of ["user", "project"] as const) {
    for (const preset of readLayerPresetEntries(rootDir, layer)) {
      byId.set(presetEntryId(preset), preset);
    }
  }
  return [...byId.values()].sort((left, right) => presetEntryId(left).localeCompare(presetEntryId(right)));
}

export function discoverPresets(rootDir: string): ReadonlyArray<ResolvedPreset> {
  return discoverPresetEntries(rootDir).filter(isResolvedPreset);
}

export function resolvePresetEntry(rootDir: string, presetId: string): PresetResolutionEntry | undefined {
  return discoverPresetEntries(rootDir).find((preset) => presetEntryId(preset) === presetId);
}

export function resolvePreset(rootDir: string, presetId: string): ResolvedPreset | undefined {
  const entry = resolvePresetEntry(rootDir, presetId);
  return entry && !isInvalidPreset(entry) ? entry : undefined;
}

export function publicPresetSummary(preset: ResolvedPreset): Record<string, unknown> {
  const validation = validatePresetManifestForUse(preset.manifest);
  return {
    id: preset.manifest.id,
    title: preset.manifest.title,
    version: preset.manifest.version,
    vertical: preset.manifest.vertical,
    defaultProfile: preset.manifest.defaultProfile,
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

function readLayerPresetEntries(rootDir: string, layer: "project" | "user"): ReadonlyArray<PresetResolutionEntry> {
  const layerRoot = presetLayerRoot(rootDir, layer);
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

export function bundledPresetManifests(): ReadonlyArray<PresetManifest> {
  return bundledPresetIds.map((id): PresetManifest => ({
    schema: "preset-manifest/v1",
    id,
    title: titleizePresetId(id),
    vertical: "software/coding",
    version: "1.0.0",
    kernelVersionRange: {
      min: "1.0.0",
      maxExclusive: "2.0.0"
    },
    capabilityImports: [{
      id: `${id}-check`,
      kind: "checker",
      version: "1",
      required: false
    }],
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      templateSelections: bundledTemplateSelectionsForPreset(id)
    }],
    defaultProfile: "baseline"
  }));
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
  const materialized = planTemplateMaterialization({
    catalog: bundledSoftwareCodingTemplateCatalog,
    locale: options.locale,
    selections: combineVerticalAndPresetSelections(profile.templateSelections)
  });
  return {
    ok: materialized.ok,
    profile,
    documents: materialized.documents,
    issues: materialized.issues
  };
}

function titleizePresetId(id: string): string {
  return id.split("-").map((part) => part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
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

function decodePresetManifestFile(presetPath: string): PresetManifest {
  const decoded = decodePresetManifestFileResult(presetPath);
  if (!decoded.ok) {
    throw new Error("preset manifest shape invalid");
  }
  return decoded.value;
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

function presetLayerRoot(rootDir: string, layer: "project" | "user"): string {
  const layout = resolveHarnessLayout(rootDir);
  return layer === "project"
    ? path.join(layout.localRoot, "presets")
    : path.join(layout.localRoot, "user-presets");
}

export function presetManifestPath(rootDir: string, layer: "project" | "user", presetId: string): string {
  validateRegistryKey(presetId, "preset");
  return path.join(presetLayerRoot(rootDir, layer), presetId, "preset.json");
}

export function runPresetEntrypoint(
  rootDir: string,
  presetId: string,
  entrypoint: "plan" | "scaffold" | "check",
  taskId: string,
  commandName: "preset-run" | "preset-action"
): CliResult {
  const preset = resolvePresetEntry(rootDir, presetId);
  if (!preset) return presetNotFound("preset-run", presetId);
  if (isInvalidPreset(preset)) {
    return {
      ok: false,
      command: commandName,
      preset: { id: preset.id, layer: preset.layer, valid: false },
      issues: preset.issues,
      error: { code: "preset_manifest_invalid", hint: "Preset manifest failed validation." }
    };
  }
  const validation = validatePresetManifestForUse(preset.manifest);
  if (!validation.ok) {
    return {
      ok: false,
      command: commandName,
      preset: publicPresetSummary(preset),
      issues: validation.issues,
      error: { code: "preset_manifest_invalid", hint: "Preset manifest failed validation." }
    };
  }
  validateRegistryKey(taskId, "task");
  const evidenceDir = path.join(resolveHarnessLayout(rootDir).localRoot, "evidence", "presets", presetId, timestampForPath());
  mkdirSync(evidenceDir, { recursive: true });
  const generated: string[] = [];
  if (entrypoint === "scaffold") {
    const outputPath = path.join(resolveHarnessLayout(rootDir).generatedRoot, "preset-scaffold", taskId, `${presetId}.md`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `# ${preset.manifest.title}\n\nTask: ${taskId}\n`, "utf8");
    generated.push(path.relative(rootDir, outputPath).split(path.sep).join("/"));
  }
  const evidence = {
    schema: "preset-evidence/v1",
    presetId,
    layer: preset.layer,
    taskId,
    entrypoint,
    generated,
    ok: true
  };
  writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
  return {
    ok: true,
    command: commandName,
    preset: publicPresetSummary(preset),
    evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
    report: evidence
  };
}

export function readModules(rootDir: string): ModuleRegistry {
  const registryPath = modulesRegistryPath(rootDir);
  if (!existsSync(registryPath)) return { modules: [] };
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { readonly modules?: ReadonlyArray<ModuleRecord> };
  return { modules: parsed.modules ?? [] };
}

export function writeModules(rootDir: string, registry: ModuleRegistry): void {
  const registryPath = modulesRegistryPath(rootDir);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ schema: "module-registry/v1", modules: registry.modules }, null, 2), "utf8");
  writeModuleRegistryView(rootDir, registry);
}

function modulesRegistryPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).authoredRoot, "modules.json");
}

function writeModuleRegistryView(rootDir: string, registry: ModuleRegistry): void {
  const outputPath = path.join(resolveHarnessLayout(rootDir).generatedRoot, "Module-Registry.md");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = registry.modules
    .map((module) => `| ${module.key} | ${module.title} | ${module.status} | ${module.scopes.join("<br>")} | ${module.steps.map((step) => `${step.id}:${step.state}`).join(", ")} |`)
    .join("\n");
  writeFileSync(outputPath, [
    "# Module Registry",
    "",
    "| Key | Title | Status | Scopes | Steps |",
    "| --- | --- | --- | --- | --- |",
    rows,
    ""
  ].join("\n"), "utf8");
}

export function presetNotFound(command: string, presetId: string): CliResult {
  return {
    ok: false,
    command,
    preset: { id: presetId },
    error: { code: "preset_not_found", hint: `Preset ${presetId} was not found.` }
  };
}

export function moduleNotFound(command: string, moduleKey: string): CliResult {
  return {
    ok: false,
    command,
    module: { key: moduleKey },
    error: { code: "module_not_found", hint: `Module ${moduleKey} was not found.` }
  };
}

function validateRegistryKey(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new Error(`invalid_registry_key:${label}`);
  }
}

function timestampForPath(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/gu, "-");
}

function bundledTemplateSelectionsForPreset(id: typeof bundledPresetIds[number]): PresetManifest["profiles"][number]["templateSelections"] {
  if (id === "standard-task" || id === "module") {
    return bundledTaskTemplateSelections();
  }
  return [];
}

function validateAdditiveSoftwareCodingPreset(manifest: PresetManifest): ReadonlyArray<ExtensionValidationIssue> {
  const issues: ExtensionValidationIssue[] = [];
  if (manifest.vertical !== bundledSoftwareCodingVerticalDefinition.id) {
    issues.push(extensionIssue("custom_vertical_forbidden", "P08 only allows software/coding preset overrides; custom vertical exposure is gated by P10/P11.", "vertical"));
  }

  const requiredBySlot = new Map(bundledSoftwareCodingVerticalDefinition.templateSelections.map((selection) => [selection.slot, selection]));
  const requiredByPath = new Map(bundledSoftwareCodingVerticalDefinition.templateSelections.map((selection) => [selection.materializeAs, selection]));

  for (const [profileIndex, profile] of manifest.profiles.entries()) {
    const materializedPaths = new Set<string>();
    const materialized = planTemplateMaterialization({
      catalog: bundledSoftwareCodingTemplateCatalog,
      locale: "zh-CN",
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
      if (requiredSlot && (requiredSlot.templateRef !== selection.templateRef || requiredSlot.materializeAs !== selection.materializeAs)) {
        issues.push(extensionIssue("preset_required_template_conflict", `Preset ${manifest.id} cannot replace vertical-required slot ${selection.slot}.`, path));
      }
      const requiredPath = requiredByPath.get(selection.materializeAs);
      if (requiredPath && (requiredPath.slot !== selection.slot || requiredPath.templateRef !== selection.templateRef)) {
        issues.push(extensionIssue("preset_required_template_conflict", `Preset ${manifest.id} cannot replace vertical-required document ${selection.materializeAs}.`, path));
      }
    }
  }

  return issues;
}

function combineVerticalAndPresetSelections(
  presetSelections: ReadonlyArray<PresetManifest["profiles"][number]["templateSelections"][number]>
): PresetManifest["profiles"][number]["templateSelections"] {
  const byPath = new Map<string, PresetManifest["profiles"][number]["templateSelections"][number]>();
  for (const selection of bundledSoftwareCodingVerticalDefinition.templateSelections) {
    byPath.set(selection.materializeAs, selection);
  }
  for (const selection of presetSelections) {
    const existing = byPath.get(selection.materializeAs);
    if (existing && existing.slot === selection.slot && existing.templateRef === selection.templateRef) continue;
    byPath.set(selection.materializeAs, selection);
  }
  return [...byPath.values()];
}

function extensionIssue(code: ExtensionValidationIssue["code"], message: string, pathValue: string): ExtensionValidationIssue {
  return { code, message, path: pathValue };
}

function presetEntryId(entry: PresetResolutionEntry): string {
  return isInvalidPreset(entry) ? entry.id : entry.manifest.id;
}
