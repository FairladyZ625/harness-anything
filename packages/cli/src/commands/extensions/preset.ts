import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput, WriteOp } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { resolveActiveVertical } from "./active-vertical.ts";
import {
  discoverPresets,
  isInvalidPreset,
  loadBundledPresetManifests,
  presetManifestPath,
  presetNotFound,
  publicPresetSummary,
  resolvePresetEntry,
  runPresetEntrypoint,
  validatePresetManifestForUse
} from "./state.ts";
import { invalidResolvedPresetResult } from "./shared.ts";
import { buildPresetUninstallImpact } from "./preset-uninstall-impact.ts";
import { readPresetManifestFromSourceResult } from "./preset-manifest-reader.ts";
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
    | "preset-run"
    | "preset-action"
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
      return runPresetValidate(action);
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
    case "preset-run":
      return runPresetEntrypoint(rootInput, activeVerticalId!, action.presetId, action.entrypoint, action.taskId, "preset-run", pendingOps, action.allowScripts, action.inputs);
    case "preset-action":
      return runPresetAction(rootInput, activeVerticalId!, action, pendingOps);
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
  const target = presetManifestPath(rootInput, action.layer, manifest.id);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
  return {
    ok: true,
    command: "preset-install",
    preset: publicPresetSummary({ manifest, layer: action.layer, sourcePath: target })
  };
}

function runPresetSeed(rootInput: HarnessLayoutInput, activeVerticalId: string): CliResult {
  for (const manifest of loadBundledPresetManifests().filter((candidate) => candidate.vertical === activeVerticalId)) {
    const target = presetManifestPath(rootInput, "user", manifest.id);
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(manifest, null, 2), "utf8");
    }
  }
  return {
    ok: true,
    command: "preset-seed",
    presets: discoverPresets(rootInput, activeVerticalId)
      .filter((preset) => preset.layer === "user")
      .map(publicPresetSummary)
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
  rmSync(path.dirname(target), { recursive: true, force: true });
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

function runPresetAction(rootInput: HarnessLayoutInput, activeVerticalId: string, action: Extract<PresetAction, { readonly kind: "preset-action" }>, pendingOps: WriteOp[]): CliResult {
  const preset = resolvePresetEntry(rootInput, action.presetId, activeVerticalId);
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
  return runPresetEntrypoint(rootInput, activeVerticalId, action.presetId, action.actionName, action.taskId, "preset-action", pendingOps, action.allowScripts, action.inputs);
}

function usesActiveVertical(action: PresetAction): boolean {
  return action.kind !== "preset-validate" && action.kind !== "preset-install" && action.kind !== "preset-uninstall";
}
