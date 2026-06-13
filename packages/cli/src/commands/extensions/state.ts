import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import { PresetManifestSchema, validateExtensionInputShape } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import type { CliResult } from "../../cli/types.ts";

type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;

interface ResolvedPreset {
  readonly manifest: PresetManifest;
  readonly layer: "project" | "user" | "builtin";
  readonly sourcePath: string;
}

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

export function discoverPresets(rootDir: string): ReadonlyArray<ResolvedPreset> {
  const byId = new Map<string, ResolvedPreset>();
  for (const manifest of bundledPresetManifests()) {
    byId.set(manifest.id, { manifest, layer: "builtin", sourcePath: `builtin:${manifest.id}` });
  }
  for (const layer of ["user", "project"] as const) {
    for (const preset of readLayerPresets(rootDir, layer)) {
      byId.set(preset.manifest.id, preset);
    }
  }
  return [...byId.values()].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export function resolvePreset(rootDir: string, presetId: string): ResolvedPreset | undefined {
  return discoverPresets(rootDir).find((preset) => preset.manifest.id === presetId);
}

export function publicPresetSummary(preset: ResolvedPreset): Record<string, unknown> {
  return {
    id: preset.manifest.id,
    title: preset.manifest.title,
    version: preset.manifest.version,
    vertical: preset.manifest.vertical,
    defaultProfile: preset.manifest.defaultProfile,
    layer: preset.layer,
    sourcePath: safePresetSourcePath(preset.sourcePath)
  };
}

function safePresetSourcePath(sourcePath: string): string {
  return sourcePath.startsWith("builtin:") ? sourcePath : sourcePath.split(path.sep).slice(-3).join("/");
}

function readLayerPresets(rootDir: string, layer: "project" | "user"): ReadonlyArray<ResolvedPreset> {
  const layerRoot = presetLayerRoot(rootDir, layer);
  if (!existsSync(layerRoot)) return [];
  return readdirSync(layerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(layerRoot, entry.name, "preset.json"))
    .filter((presetPath) => existsSync(presetPath))
    .map((presetPath) => ({
      manifest: decodePresetManifestFile(presetPath),
      layer,
      sourcePath: presetPath
    }));
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
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }));
}

function titleizePresetId(id: string): string {
  return id.split("-").map((part) => part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

export function readPresetManifestFromSource(sourcePath: string): PresetManifest {
  const resolved = path.resolve(sourcePath);
  const presetPath = existsSync(path.join(resolved, "preset.json")) ? path.join(resolved, "preset.json") : resolved;
  return decodePresetManifestFile(presetPath);
}

function decodePresetManifestFile(presetPath: string): PresetManifest {
  const raw = JSON.parse(readFileSync(presetPath, "utf8")) as unknown;
  const shape = validateExtensionInputShape("preset-manifest", raw);
  if (!shape.ok) {
    throw new Error("preset manifest shape invalid");
  }
  return Schema.decodeUnknownSync(PresetManifestSchema)(raw);
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
  const preset = resolvePreset(rootDir, presetId);
  if (!preset) return presetNotFound("preset-run", presetId);
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
