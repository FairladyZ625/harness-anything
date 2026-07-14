import { validatePresetManifests, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import {
  discoverPresetEntries,
  isInvalidPreset,
  isResolvedPreset,
  loadBundledPresetManifests,
  presetNotFound,
  publicPresetEntrySummary,
  publicPresetSummary,
  resolvePresetEntry,
  validatePresetManifestForUse
} from "./state.ts";
import { decodePresetManifest, invalidExtensionResult, invalidResolvedPresetResult } from "./shared.ts";

export function runPresetValidate(action: {
  readonly manifestPath: string;
  readonly kernelVersion: string;
}): CliResult {
  const decoded = decodePresetManifest(action.manifestPath);
  if (!decoded.ok) {
    return invalidExtensionResult("preset-validate", CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.", decoded.issues);
  }
  const manifest = decoded.value;
  const validation = validatePresetManifests([manifest], { kernelVersion: action.kernelVersion });
  if (!validation.ok) {
    return {
      ok: false,
      command: "preset-validate",
      issues: validation.issues,
      error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
    };
  }
  return {
    ok: true,
    command: "preset-validate",
    preset: { id: manifest.id, version: manifest.version },
    report: { schema: "preset-validate-report/v1", issueCount: validation.issues.length }
  };
}

export function runPresetList(rootInput: HarnessLayoutInput, activeVerticalId: string): CliResult {
  const entries = discoverPresetEntries(rootInput, activeVerticalId);
  const issues = entries.flatMap((entry) => isInvalidPreset(entry) ? entry.issues : validatePresetManifestForUse(entry.manifest).issues);
  return {
    ok: issues.length === 0,
    command: "preset-list",
    presets: entries.map(publicPresetEntrySummary),
    issues,
    error: issues.length === 0 ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "One or more resolved presets failed validation.")
  };
}

export function runPresetInspect(rootInput: HarnessLayoutInput, presetId: string, activeVerticalId: string): CliResult {
  const preset = resolvePresetEntry(rootInput, presetId, activeVerticalId);
  if (!preset) return presetNotFound("preset-inspect", presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-inspect", preset);
  const validation = validatePresetManifestForUse(preset.manifest);
  return {
    ok: validation.ok,
    command: "preset-inspect",
    preset: { ...publicPresetSummary(preset), manifest: preset.manifest },
    issues: validation.issues,
    error: validation.ok ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
  };
}

export function runPresetCheck(rootInput: HarnessLayoutInput, presetId: string, activeVerticalId: string): CliResult {
  const preset = resolvePresetEntry(rootInput, presetId, activeVerticalId);
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

export function runPresetAudit(rootInput: HarnessLayoutInput, activeVerticalId: string): CliResult {
  const resolved = discoverPresetEntries(rootInput, activeVerticalId);
  const bundledById = new Map(loadBundledPresetManifests()
    .filter((manifest) => manifest.vertical === activeVerticalId)
    .map((manifest) => [manifest.id, manifest.version]));
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
    report: { totalResolved: resolved.length, drift },
    error: issues.length === 0 ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "One or more resolved presets failed validation.")
  };
}
