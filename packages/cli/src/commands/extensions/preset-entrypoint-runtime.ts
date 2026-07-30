import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, taskPackagePath, type HarnessLayoutInput, type WriteOp } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { demotedGateWarning } from "../../cli/demoted-gate-warning.ts";
import type { CliResult } from "../../cli/types.ts";
import { semanticPresetScriptEntry } from "./preset-capability-runtime.ts";
import { recordPresetScriptAuthorizationWarning } from "./preset-evidence.ts";
import { runLegacyPresetScriptEntrypoint, scriptCliResult, type LegacyPresetScriptEntrypoint } from "./preset-script-runner.ts";
import { presetRuntimeUnavailableResult } from "./preset-runtime-availability.ts";
import { withPresetRuntimeWarning } from "./preset-runtime-mode.ts";
import { runScriptHost } from "./script-host.ts";
import {
  discoverPresets,
  isInvalidPreset,
  presetNotFound,
  publicPresetSummary,
  resolvePresetEntry,
  validatePresetManifestForUse,
  validateRegistryKey
} from "./state.ts";

export function runPresetEntrypoint(
  rootInput: HarnessLayoutInput,
  verticalId: string,
  presetId: string,
  entrypoint: string,
  taskId: string,
  commandName: "preset-run" | "preset-action",
  pendingOps: WriteOp[],
  allowScripts = false,
  inputs: Record<string, string> = {}
): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  validateRegistryKey(taskId, "task");
  const preset = resolvePresetEntry(rootInput, presetId, verticalId);
  const runtimeUnavailable = presetRuntimeUnavailableResult({
    rootInput,
    commandName,
    presetId,
    taskId,
    ...(preset && !isInvalidPreset(preset) ? { installedPreset: preset.manifest } : {})
  });
  if (runtimeUnavailable) return runtimeUnavailable;
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
  const finish = (result: CliResult): CliResult => withPresetRuntimeWarning(result, preset.manifest);
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
  const evidenceDir = path.join(layout.localRoot, "evidence", "presets", presetId, timestampForPath());
  const generated: string[] = [];
  const declaredEntrypoint = preset.manifest.entrypoints?.[entrypoint];
  if (preset.manifest.schema === "preset-manifest/v3") {
    const semanticEntrypoint = preset.manifest.entrypoints?.[entrypoint];
    if (semanticEntrypoint?.type !== "script") {
      return presetActionWarningResult(
        commandName,
        publicPresetSummary(preset),
        presetId,
        taskId,
        entrypoint
      );
    }
    const presetSummary = publicPresetSummary(preset);
    const authorizationWarnings = allowScripts ? [] : (() => {
      mkdirSync(evidenceDir, { recursive: true });
      return [recordPresetScriptAuthorizationWarning({ evidenceDir, presetId, taskId, entrypoint })];
    })();
    const run = runScriptHost({
      rootInput,
      commandName,
      script: {
        ...semanticPresetScriptEntry({ ...preset, manifest: preset.manifest }, entrypoint, semanticEntrypoint),
        context: {
          presetId,
          presetTitle: preset.manifest.title,
          entrypoint,
          taskId
        }
      },
      inputs,
      outputRoot: taskPackagePath(rootInput, taskId),
      requireScriptResult: true
    });
    if (run.ingestOp) pendingOps.push(run.ingestOp);
    if (!run.ok) {
      return {
        ...run.result,
        command: commandName,
        preset: presetSummary,
        taskId,
        warnings: [...(run.result.warnings ?? []), ...authorizationWarnings]
      };
    }
    return {
      ok: true,
      command: commandName,
      preset: presetSummary,
      taskId,
      runId: run.runId,
      evidenceBundle: path.relative(rootDir, run.runDir).split(path.sep).join("/"),
      generated: run.generated,
      warnings: [
        ...(Array.isArray(run.scriptedResult.warnings) ? run.scriptedResult.warnings : []),
        ...authorizationWarnings
      ],
      rows: typeof run.scriptedResult.rows === "number" ? run.scriptedResult.rows : undefined,
      report: run.scriptedResult.report ?? run.scriptedResult,
      capabilityReceipt: run.capabilityReceipt
    };
  }
  if (declaredEntrypoint?.type === "script") {
    mkdirSync(evidenceDir, { recursive: true });
    const authorizationWarnings = allowScripts
      ? []
      : [recordPresetScriptAuthorizationWarning({ evidenceDir, presetId, taskId, entrypoint })];
    const presetSummary = publicPresetSummary(preset);
    const legacyEntrypoint = declaredEntrypoint as LegacyPresetScriptEntrypoint;
    const scriptResult = runLegacyPresetScriptEntrypoint(rootInput, preset, discoverPresets(rootInput, verticalId), presetSummary, legacyEntrypoint, entrypoint, taskId, evidenceDir, commandName, inputs);
    if (!scriptResult.ok) {
      return finish({
        ...scriptResult.result,
        warnings: [...(scriptResult.result.warnings ?? []), ...authorizationWarnings]
      });
    }
    generated.push(...scriptResult.generated);
    if (scriptResult.ingestOp) pendingOps.push(scriptResult.ingestOp);
    if (scriptResult.scriptedResult) {
      const result = scriptCliResult({
        rootDir,
        evidenceDir,
        commandName,
        preset: presetSummary,
        taskId,
        generated,
        scriptedResult: scriptResult.scriptedResult
      });
      return finish({
        ...result,
        warnings: [...(result.warnings ?? []), ...authorizationWarnings]
      });
    }
  } else if (preset.manifest.schema === "preset-manifest/v1" && entrypoint === "scaffold") {
    const outputPath = path.join(layout.generatedRoot, "preset-scaffold", taskId, `${presetId}.md`);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `# ${preset.manifest.title}\n\nTask: ${taskId}\n`, "utf8");
    generated.push(path.relative(rootDir, outputPath).split(path.sep).join("/"));
  } else {
    return finish(presetActionWarningResult(
      commandName,
      publicPresetSummary(preset),
      presetId,
      taskId,
      entrypoint
    ));
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
  return finish({
    ok: true,
    command: commandName,
    preset: publicPresetSummary(preset),
    taskId,
    evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
    generated,
    report: evidence
  });
}

function presetActionWarningResult(
  commandName: "preset-run" | "preset-action",
  preset: unknown,
  presetId: string,
  taskId: string,
  entrypoint: string
): CliResult {
  return {
    ok: true,
    command: commandName,
    preset,
    taskId,
    warnings: [demotedGateWarning(
      "preset_action_forbidden",
      `Preset ${presetId} does not declare action ${entrypoint}; no preset action was executed.`
    )],
    report: {
      schema: "preset-action-result/v1",
      entrypoint,
      executed: false
    }
  };
}

function timestampForPath(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/gu, "-");
}
