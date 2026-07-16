import path from "node:path";
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
import { documentedPresetSource, loadPresetDocument } from "./preset-document-loader.ts";
import { preflightPresetPackage, type PresetPackagePreflightReceipt } from "./preset-preflight.ts";

export function runPresetValidate(rootInput: HarnessLayoutInput, action: {
  readonly manifestPath: string;
  readonly kernelVersion: string;
}): CliResult {
  const decoded = decodePresetManifest(action.manifestPath);
  if (!decoded.ok) {
    return invalidExtensionResult("preset-validate", CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.", decoded.issues);
  }
  const manifest = decoded.value;
  const document = loadPresetDocument(action.manifestPath);
  const validation = validatePresetManifests([manifest], { kernelVersion: action.kernelVersion });
  if (!validation.ok) {
    return {
      ok: false,
      command: "preset-validate",
      issues: validation.issues,
      warnings: document.warnings,
      error: cliError(CliErrorCode.PresetManifestInvalid, "Preset manifest failed validation.")
    };
  }
  const sourcePreset = documentedPresetSource(manifest, "project", path.resolve(action.manifestPath));
  const preflight = preflightPresetPackage(rootInput, sourcePreset);
  const warnings = [...document.warnings, ...preflight.warnings];
  if (!preflight.ok) {
    return {
      ok: false,
      command: "preset-validate",
      preset: { id: manifest.id, version: manifest.version, valid: false },
      issues: preflight.issues,
      report: { schema: "preset-validate-report/v1", issueCount: preflight.issues.length, preflight: preflight.receipt },
      warnings,
      error: cliError(CliErrorCode.PresetManifestInvalid, preflight.hint)
    };
  }
  return {
    ok: true,
    command: "preset-validate",
    preset: { id: manifest.id, version: manifest.version },
    report: { schema: "preset-validate-report/v1", issueCount: validation.issues.length, preflight: preflight.receipt },
    warnings
  };
}

export function runPresetList(rootInput: HarnessLayoutInput, activeVerticalId: string): CliResult {
  const entries = discoverPresetEntries(rootInput, activeVerticalId);
  const validations = entries.map(summarizeResolvedPreset);
  const issues = validations.flatMap((entry) => entry.issues);
  const warnings = validations.flatMap((entry) => entry.warnings);
  return {
    ok: true,
    command: "preset-list",
    presets: validations.map((entry) => entry.summary),
    issues,
    warnings
  };
}

function summarizeResolvedPreset(
  entry: ReturnType<typeof discoverPresetEntries>[number]
): {
  readonly issues: ReadonlyArray<unknown>;
  readonly warnings: ReadonlyArray<unknown>;
  readonly summary: Record<string, unknown>;
} {
  if (isInvalidPreset(entry)) {
    return { issues: entry.issues, warnings: [], summary: publicPresetEntrySummary(entry) };
  }
  const structural = validatePresetManifestForUse(entry.manifest);
  return {
    issues: structural.issues,
    warnings: entry.warnings ?? [],
    summary: {
      ...publicPresetSummary(entry),
      valid: structural.ok,
      issueCount: structural.issues.length
    }
  };
}

export function runPresetInspect(rootInput: HarnessLayoutInput, presetId: string, activeVerticalId: string): CliResult {
  const preset = resolvePresetEntry(rootInput, presetId, activeVerticalId);
  if (!preset) return presetNotFound("preset-inspect", presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-inspect", preset);
  const validation = validateResolvedPreset(rootInput, preset);
  return {
    ok: validation.issues.length === 0,
    command: "preset-inspect",
    preset: { ...validation.summary, manifest: preset.manifest },
    issues: validation.issues,
    warnings: validation.warnings,
    error: validation.issues.length === 0 ? undefined : cliError(
      CliErrorCode.PresetManifestInvalid,
      validation.runtimeHint || "Preset manifest failed validation."
    )
  };
}

export function runPresetCheck(rootInput: HarnessLayoutInput, presetId: string, activeVerticalId: string): CliResult {
  const preset = resolvePresetEntry(rootInput, presetId, activeVerticalId);
  if (!preset) return presetNotFound("preset-check", presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-check", preset);
  const validation = validateResolvedPreset(rootInput, preset);
  return {
    ok: validation.issues.length === 0,
    command: "preset-check",
    preset: validation.summary,
    issues: validation.issues,
    warnings: validation.warnings,
    report: { schema: "preset-check-report/v1", preflight: validation.preflight },
    error: validation.issues.length === 0 ? undefined : cliError(
      CliErrorCode.PresetManifestInvalid,
      validation.runtimeHint || "Preset manifest failed validation."
    )
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
  const validations = resolved.map((entry) => validateResolvedPreset(rootInput, entry));
  const issues = validations.flatMap((entry) => entry.issues);
  const warnings = validations.flatMap((entry) => entry.warnings);
  return {
    ok: issues.length === 0,
    command: "preset-audit",
    presets: validations.map((entry) => entry.summary),
    issues,
    warnings,
    report: {
      schema: "preset-audit-report/v1",
      totalResolved: resolved.length,
      drift,
      preflights: validations.flatMap((validation) => validation.preflight ? [validation.preflight] : [])
    },
    error: issues.length === 0 ? undefined : cliError(CliErrorCode.PresetManifestInvalid, "One or more resolved presets failed validation.")
  };
}

function validateResolvedPreset(
  rootInput: HarnessLayoutInput,
  entry: ReturnType<typeof discoverPresetEntries>[number]
): {
  readonly issues: ReadonlyArray<unknown>;
  readonly warnings: ReadonlyArray<unknown>;
  readonly summary: Record<string, unknown>;
  readonly runtimeHint: string;
  readonly preflight?: PresetPackagePreflightReceipt;
} {
  if (isInvalidPreset(entry)) {
    return { issues: entry.issues, warnings: [], summary: publicPresetEntrySummary(entry), runtimeHint: "" };
  }
  const structural = validatePresetManifestForUse(entry.manifest);
  const runtime = structural.ok ? preflightPresetPackage(rootInput, entry) : undefined;
  const issues = [...structural.issues, ...(runtime?.issues ?? [])];
  const badges = runtime?.receipt.entrypoints.flatMap((entrypoint) => entrypoint.escapeHatches.map((escapeHatch) => ({
    kind: "raw-fs",
    entrypoint: entrypoint.name,
    id: escapeHatch.id,
    access: escapeHatch.access,
    status: escapeHatch.admitted ? "admitted" : "denied",
    expiresAt: escapeHatch.expiresAt
  }))) ?? [];
  return {
    issues,
    warnings: [...(entry.warnings ?? []), ...(runtime?.warnings ?? [])],
    summary: {
      ...publicPresetSummary(entry),
      valid: issues.length === 0,
      issueCount: issues.length,
      ...(badges.length > 0 ? { badges } : {})
    },
    runtimeHint: runtime?.hint ?? "",
    preflight: runtime?.receipt
  };
}
