import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput, WriteOp } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { isPresetRunEntrypoint } from "../../cli/preset-entrypoint-capabilities.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { resolveActiveVertical } from "./active-vertical.ts";
import {
  discoverPresets,
  isInvalidPreset,
  presetManifestPath,
  presetNotFound,
  publicPresetSummary,
  resolvePresetEntry,
  validatePresetManifestForUse
} from "./state.ts";
import { runPresetEntrypoint } from "./preset-entrypoint-runtime.ts";
import { invalidResolvedPresetResult } from "./shared.ts";
import { buildPresetUninstallImpact } from "./preset-uninstall-impact.ts";
import { readPresetManifestFromSourceResult } from "./preset-manifest-reader.ts";
import { loadBundledPresetManifestEntries } from "./bundled.ts";
import { preflightPresetPackage } from "./preset-preflight.ts";
import { copyPresetPackage, presetManifestPathFromSource } from "./preset-package-files.ts";
import { documentedPresetSource } from "./preset-document-loader.ts";
import {
  runPresetAudit,
  runPresetCheck,
  runPresetInspect,
  runPresetList,
  runPresetValidate
} from "./preset-query.ts";
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
    | "preset-entrypoint"
}>;
export function runPresetCommand(rootInput: HarnessLayoutInput, action: PresetAction, pendingOps: WriteOp[]): CliResult {
  let activeVerticalId: string | undefined;
  if (usesActiveVertical(action)) {
    const activeVertical = resolveActiveVertical(rootInput, action.kind);
    if (!activeVertical.ok) return activeVertical.result;
    activeVerticalId = activeVertical.id;
  }

  switch (action.kind) {
    case "preset-validate":
      return runPresetValidate(rootInput, action);
    case "preset-list":
      return runPresetList(rootInput, activeVerticalId!);
    case "preset-inspect":
      return runPresetInspect(rootInput, action.presetId, activeVerticalId!);
    case "preset-check":
      return runPresetCheck(rootInput, action.presetId, activeVerticalId!);
    case "preset-install":
      return runPresetInstall(rootInput, action);
    case "preset-seed":
      return runPresetSeed(rootInput, activeVerticalId!);
    case "preset-audit":
      return runPresetAudit(rootInput, activeVerticalId!);
    case "preset-uninstall":
      return runPresetUninstall(rootInput, action);
    case "preset-entrypoint":
      if (action.entrypointType === "action") return runPresetAction(rootInput, activeVerticalId!, action, pendingOps);
      if (!isPresetRunEntrypoint(action.entrypointName)) {
        return { ok: false, command: "preset-run", error: cliError(CliErrorCode.InvalidEntrypoint, `Unknown preset entrypoint: ${action.entrypointName}`) };
      }
      return runPresetEntrypoint(rootInput, activeVerticalId!, action.presetId, action.entrypointName, action.taskId, "preset-run", pendingOps, action.allowScripts, action.inputs);
  }
}

function runPresetInstall(rootInput: HarnessLayoutInput, action: Extract<PresetAction, { readonly kind: "preset-install" }>): CliResult {
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
  const sourceManifestPath = presetManifestPathFromSource(action.sourcePath);
  const sourcePreset = documentedPresetSource(manifest, action.layer, sourceManifestPath);
  const preflight = preflightPresetPackage(rootInput, sourcePreset);
  const warnings = [...(sourcePreset.warnings ?? []), ...preflight.warnings];
  if (!preflight.ok) {
    return {
      ok: false,
      command: "preset-install",
      preset: { id: manifest.id, valid: false },
      issues: preflight.issues,
      report: { schema: "preset-install-report/v1", preflight: preflight.receipt },
      warnings,
      error: cliError(CliErrorCode.PresetManifestInvalid, preflight.hint)
    };
  }
  const target = presetManifestPath(rootInput, action.layer, manifest.id);
  const writeInstalledFile = (filePath: string, body: Buffer | string): void => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  };
  copyPresetPackage(path.dirname(sourceManifestPath), path.dirname(target), writeInstalledFile, { prepareTarget: removePresetPackage });
  writeInstalledFile(target, JSON.stringify(manifest, null, 2));
  return {
    ok: true,
    command: "preset-install",
    preset: publicPresetSummary({ ...sourcePreset, sourcePath: target }),
    report: { schema: "preset-install-report/v1", preflight: preflight.receipt },
    warnings
  };
}

function runPresetSeed(rootInput: HarnessLayoutInput, activeVerticalId: string): CliResult {
  const bundled = loadBundledPresetManifestEntries().filter((candidate) => candidate.manifest.vertical === activeVerticalId);
  const writeSeedFile = (filePath: string, body: Buffer | string): void => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  };
  for (const entry of bundled) {
    const target = presetManifestPath(rootInput, "user", entry.manifest.id);
    copyPresetPackage(path.dirname(entry.sourcePath), path.dirname(target), writeSeedFile);
    if (!existsSync(target)) {
      writeSeedFile(target, JSON.stringify(entry.manifest, null, 2));
    }
  }
  return {
    ok: true,
    command: "preset-seed",
    presets: discoverPresets(rootInput, activeVerticalId)
      .filter((preset) => preset.layer === "user")
      .map(publicPresetSummary),
    report: {
      schema: "preset-seed-report/v1",
      packageCount: bundled.length,
      mode: "complete-package"
    }
  };
}

function runPresetUninstall(rootInput: HarnessLayoutInput, action: Extract<PresetAction, { readonly kind: "preset-uninstall" }>): CliResult {
  const target = presetManifestPath(rootInput, action.layer, action.presetId);
  if (!existsSync(target)) return presetNotFound("preset-uninstall", action.presetId);
  const impact = buildPresetUninstallImpact(rootInput, action.presetId, target);
  const report = {
    ...impact,
    mode: action.dryRun ? "dry-run" : "apply",
    removed: false
  };
  if (!impact.allowed) {
    const needsMigration = impact.tasks.some((task) =>
      task.reason === "task_contract_snapshot_missing" ||
      task.reason === "task_contract_snapshot_invalid" ||
      task.reason === "task_contract_snapshot_metadata_mismatch"
    );
    const needsRuntimeRetirement = impact.tasks.some((task) =>
      task.reason === "preset_private_runtime_required" || task.reason === "preset_private_runtime_unknown"
    );
    const needsStateRepair = impact.tasks.some((task) => task.reason === "task_state_unproven");
    const guidance = [
      needsMigration ? "Run task contract migrate first for every unproven inbound Task." : "",
      needsRuntimeRetirement ? "Finish affected Tasks, migrate them to a generic action, or retire them first." : "",
      needsStateRepair ? "Repair unproven Task lifecycle metadata before uninstalling the preset." : ""
    ].filter(Boolean).join(" ");
    return {
      ok: false,
      command: "preset-uninstall",
      preset: { id: action.presetId, layer: action.layer },
      report,
      error: cliError(CliErrorCode.PresetUninstallBlocked, `Preset uninstall blocked. ${guidance}`.trim())
    };
  }
  if (action.dryRun) {
    return {
      ok: true,
      command: "preset-uninstall",
      preset: { id: action.presetId, layer: action.layer },
      report
    };
  }
  removePresetPackage(path.dirname(target));
  return {
    ok: true,
    command: "preset-uninstall",
    preset: {
      id: action.presetId,
      layer: action.layer
    },
    report: { ...report, removed: true }
  };
}

function removePresetPackage(targetRoot: string): void {
  rmSync(targetRoot, { recursive: true, force: true });
}

function runPresetAction(rootInput: HarnessLayoutInput, activeVerticalId: string, action: Extract<PresetAction, { readonly kind: "preset-entrypoint" }>, pendingOps: WriteOp[]): CliResult {
  const preset = resolvePresetEntry(rootInput, action.presetId, activeVerticalId);
  if (!preset) return presetNotFound("preset-action", action.presetId);
  if (isInvalidPreset(preset)) return invalidResolvedPresetResult("preset-action", preset);
  const declared = preset.manifest.entrypoints?.[action.entrypointName];
  if (!declared && action.entrypointName !== "plan" && action.entrypointName !== "scaffold" && action.entrypointName !== "check") {
    return {
      ok: false,
      command: "preset-action",
      preset: { id: action.presetId },
      error: cliError(CliErrorCode.PresetActionForbidden, `Preset action ${action.entrypointName} is not declared.`)
    };
  }
  return runPresetEntrypoint(rootInput, activeVerticalId, action.presetId, action.entrypointName, action.taskId, "preset-action", pendingOps, action.allowScripts, action.inputs);
}

function usesActiveVertical(action: PresetAction): boolean {
  return action.kind !== "preset-validate" && action.kind !== "preset-install" && action.kind !== "preset-uninstall";
}
