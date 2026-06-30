import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validatePresetManifests } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import {
  discoverPresetEntries,
  discoverPresets,
  isInvalidPreset,
  isResolvedPreset,
  loadBundledPresetManifests,
  presetManifestPath,
  presetNotFound,
  publicPresetEntrySummary,
  publicPresetSummary,
  readPresetManifestFromSourceResult,
  resolvePresetEntry,
  runPresetEntrypoint,
  validatePresetManifestForUse
} from "./state.ts";
import { decodePresetManifest, invalidExtensionResult, invalidResolvedPresetResult } from "./shared.ts";

type PresetAction = Extract<ParsedCommand["action"], {
  readonly kind:
    | "preset-validate"
    | "preset-list"
    | "preset-inspect"
    | "preset-check"
    | "preset-install"
    | "preset-seed"
    | "preset-audit"
    | "preset-uninstall"
    | "preset-run"
    | "preset-action"
}>;

export function runPresetCommand(rootDir: string, action: PresetAction): CliResult {
  switch (action.kind) {
    case "preset-validate":
      return runPresetValidate(action);
    case "preset-list":
      return runPresetList(rootDir);
    case "preset-inspect":
      return runPresetInspect(rootDir, action.presetId);
    case "preset-check":
      return runPresetCheck(rootDir, action.presetId);
    case "preset-install":
      return runPresetInstall(rootDir, action);
    case "preset-seed":
      return runPresetSeed(rootDir);
    case "preset-audit":
      return runPresetAudit(rootDir);
    case "preset-uninstall":
      return runPresetUninstall(rootDir, action);
    case "preset-run":
      return runPresetEntrypoint(rootDir, action.presetId, action.entrypoint, action.taskId, "preset-run", action.allowScripts);
    case "preset-action":
      return runPresetAction(rootDir, action);
  }
}

function runPresetValidate(action: Extract<PresetAction, { readonly kind: "preset-validate" }>): CliResult {
  const decoded = decodePresetManifest(action.manifestPath);
  if (!decoded.ok) {
    return invalidExtensionResult("preset-validate", CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.", decoded.issues);
  }
  const manifest = decoded.value;
  const validation = validatePresetManifests([manifest], { kernelVersion: action.kernelVersion });
  return {
    ok: validation.ok,
    command: "preset-validate",
    issues: validation.issues,
    error: validation.ok ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
  };
}

function runPresetList(rootDir: string): CliResult {
  const entries = discoverPresetEntries(rootDir);
  const issues = entries.flatMap((entry) => isInvalidPreset(entry) ? entry.issues : validatePresetManifestForUse(entry.manifest).issues);
  return {
    ok: issues.length === 0,
    command: "preset-list",
    presets: entries.map(publicPresetEntrySummary),
    issues,
    error: issues.length === 0 ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "One or more resolved presets failed validation.")
  };
}

function runPresetInspect(rootDir: string, presetId: string): CliResult {
  const preset = resolvePresetEntry(rootDir, presetId);
  if (!preset) return presetNotFound("preset-inspect", presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-inspect", preset);
  const validation = validatePresetManifestForUse(preset.manifest);
  return {
    ok: validation.ok,
    command: "preset-inspect",
    preset: {
      ...publicPresetSummary(preset),
      manifest: preset.manifest
    },
    issues: validation.issues,
    error: validation.ok ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
  };
}

function runPresetCheck(rootDir: string, presetId: string): CliResult {
  const preset = resolvePresetEntry(rootDir, presetId);
  if (!preset) return presetNotFound("preset-check", presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-check", preset);
  const validation = validatePresetManifestForUse(preset.manifest);
  return {
    ok: validation.ok,
    command: "preset-check",
    preset: publicPresetSummary(preset),
    issues: validation.issues,
    error: validation.ok ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
  };
}

function runPresetInstall(rootDir: string, action: Extract<PresetAction, { readonly kind: "preset-install" }>): CliResult {
  const decoded = readPresetManifestFromSourceResult(action.sourcePath);
  if (!decoded.ok) {
    return {
      ok: false,
      command: "preset-install",
      issues: decoded.issues,
      error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
    };
  }
  const manifest = decoded.value;
  const validation = validatePresetManifestForUse(manifest);
  if (!validation.ok) {
    return {
      ok: false,
      command: "preset-install",
      preset: { id: manifest.id },
      issues: validation.issues,
      error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
    };
  }
  const target = presetManifestPath(rootDir, action.layer, manifest.id);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
  return {
    ok: true,
    command: "preset-install",
    preset: publicPresetSummary({ manifest, layer: action.layer, sourcePath: target })
  };
}

function runPresetSeed(rootDir: string): CliResult {
  for (const manifest of loadBundledPresetManifests()) {
    const target = presetManifestPath(rootDir, "user", manifest.id);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
    }
  }
  return {
    ok: true,
    command: "preset-seed",
    presets: discoverPresets(rootDir).filter((preset) => preset.layer === "user").map(publicPresetSummary)
  };
}

function runPresetAudit(rootDir: string): CliResult {
  const resolved = discoverPresetEntries(rootDir);
  const bundledById = new Map(loadBundledPresetManifests().map((manifest) => [manifest.id, manifest.version]));
  const drift = resolved
    .filter(isResolvedPreset)
    .filter((preset) => preset.layer !== "builtin" && bundledById.has(preset.manifest.id) && bundledById.get(preset.manifest.id) !== preset.manifest.version)
    .map((preset) => ({
      id: preset.manifest.id,
      layer: preset.layer,
      installedVersion: preset.manifest.version,
      bundledVersion: bundledById.get(preset.manifest.id)
    }));
  const issues = resolved.flatMap((entry) => isInvalidPreset(entry) ? entry.issues : validatePresetManifestForUse(entry.manifest).issues);
  return {
    ok: issues.length === 0,
    command: "preset-audit",
    presets: resolved.map(publicPresetEntrySummary),
    issues,
    report: {
      totalResolved: resolved.length,
      drift
    },
    error: issues.length === 0 ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "One or more resolved presets failed validation.")
  };
}

function runPresetUninstall(rootDir: string, action: Extract<PresetAction, { readonly kind: "preset-uninstall" }>): CliResult {
  const target = presetManifestPath(rootDir, action.layer, action.presetId);
  if (!existsSync(target)) return presetNotFound("preset-uninstall", action.presetId);
  rmSync(path.dirname(target), { recursive: true, force: true });
  return {
    ok: true,
    command: "preset-uninstall",
    preset: {
      id: action.presetId,
      layer: action.layer
    }
  };
}

function runPresetAction(rootDir: string, action: Extract<PresetAction, { readonly kind: "preset-action" }>): CliResult {
  const preset = resolvePresetEntry(rootDir, action.presetId);
  if (!preset) return presetNotFound("preset-action", action.presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-action", preset);
  const declared = preset.manifest.entrypoints?.[action.actionName];
  if (!declared && action.actionName !== "plan" && action.actionName !== "scaffold" && action.actionName !== "check") {
    return {
      ok: false,
      command: "preset-action",
      preset: { id: action.presetId },
      error: cliError(CliErrorCode.PresetActionForbidden, `Preset action ${action.actionName} is not declared.`)
    };
  }
  return runPresetEntrypoint(rootDir, action.presetId, action.actionName, action.taskId, "preset-action", action.allowScripts);
}
