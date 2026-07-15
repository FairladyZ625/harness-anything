import path from "node:path";
import { taskPackagePath, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import {
  isPresetRunEntrypoint,
  presetRunEntrypointCapabilities
} from "../../cli/preset-entrypoint-capabilities.ts";
import type { PresetInputV3, PresetManifestV3 } from "../../../../kernel/src/index.ts";
import { semanticPresetScriptEntry } from "./preset-capability-runtime.ts";
import { legacyPresetScriptEntry, type LegacyPresetScriptEntrypoint } from "./preset-script-runner.ts";
import type { ResolvedPreset } from "./state.ts";
import { runScriptHost, type ResolvedScriptEntry } from "./script-host.ts";

export interface PresetEntrypointSmokeIssue {
  readonly code:
    | "preset_entrypoint_runtime_unregistered"
    | "preset_entrypoint_script_missing"
    | "preset_entrypoint_smoke_failed";
  readonly message: string;
  readonly path: string;
  readonly entrypoint: string;
  readonly nextCommand: string;
}

export interface PresetEntrypointSmokeResult {
  readonly ok: boolean;
  readonly entrypoints: ReadonlyArray<{
    readonly name: string;
    readonly type: "script" | "template";
    readonly ok: boolean;
    readonly command?: string;
  }>;
  readonly issues: ReadonlyArray<PresetEntrypointSmokeIssue>;
}

export function smokePresetEntrypoints(
  rootInput: HarnessLayoutInput,
  preset: ResolvedPreset
): PresetEntrypointSmokeResult {
  const manifest = preset.manifest;
  if (manifest.schema === "preset-manifest/v3") {
    return smokePresetV3Entrypoints(rootInput, preset, manifest);
  }
  const issues: PresetEntrypointSmokeIssue[] = [];
  const entrypoints = Object.entries(manifest.entrypoints ?? {}).map(([name, entrypoint]) => {
    if (!isPresetRunEntrypoint(name)) {
      issues.push(entrypointCapabilityUnregisteredIssue(preset, name, entrypoint.type));
      return entrypoint.type === "script"
        ? { name, type: entrypoint.type, command: entrypoint.command, ok: false }
        : { name, type: entrypoint.type, ok: false };
    }
    if (entrypoint.type !== "script") {
      issues.push(runtimeUnregisteredIssue(preset, name, entrypoint.type));
      return { name, type: entrypoint.type, ok: false };
    }
    const taskId = `task_PRESET_CHECK_${safeToken(preset.manifest.id)}`;
    const script = resolvedPresetScript(preset, name, entrypoint, taskId);
    const outputRoot = taskPackagePath(rootInput, taskId);
    let smoke: ReturnType<typeof runScriptHost>;
    try {
      smoke = runScriptHost({
        rootInput,
        commandName: "preset-check",
        script,
        outputRoot,
        allowFailedScriptResult: true,
        requireScriptResult: true
      });
    } catch (error) {
      issues.push({
        code: "preset_entrypoint_smoke_failed",
        entrypoint: name,
        path: `entrypoints.${name}`,
        message: `Entrypoint ${name} failed its isolated execution smoke: ${error instanceof Error ? error.message : String(error)}`,
        nextCommand: smokeReproductionCommand(preset)
      });
      return { name, type: entrypoint.type, command: entrypoint.command, ok: false };
    }
    if (!smoke.ok) {
      const error = smoke.result.error;
      issues.push({
        code: error?.code === "script_not_found"
          ? "preset_entrypoint_script_missing"
          : "preset_entrypoint_smoke_failed",
        entrypoint: name,
        path: `entrypoints.${name}${error?.code === "script_not_found" ? ".command" : ""}`,
        message: error?.code === "script_result_failed"
          ? `Entrypoint ${name} returned script-result ok:false during its isolated smoke.`
          : `Entrypoint ${name} failed its isolated execution smoke: ${error?.hint ?? "unknown runtime failure"}`,
        nextCommand: error?.code === "script_not_found"
          ? repairCommand(preset)
          : smokeReproductionCommand(preset)
      });
    }
    return { name, type: entrypoint.type, command: entrypoint.command, ok: smoke.ok };
  });
  return { ok: issues.length === 0, entrypoints, issues };
}

function smokePresetV3Entrypoints(
  rootInput: HarnessLayoutInput,
  preset: ResolvedPreset,
  manifest: PresetManifestV3
): PresetEntrypointSmokeResult {
  const issues: PresetEntrypointSmokeIssue[] = [];
  const semanticPreset = { ...preset, manifest };
  const entrypoints = Object.entries(manifest.entrypoints ?? {}).map(([name, entrypoint]) => {
    if (!isPresetRunEntrypoint(name)) {
      issues.push(entrypointCapabilityUnregisteredIssue(preset, name, entrypoint.type));
      return entrypoint.type === "script"
        ? { name, type: entrypoint.type, command: entrypoint.command, ok: false }
        : { name, type: entrypoint.type, ok: false };
    }
    if (entrypoint.type !== "script") {
      issues.push(runtimeUnregisteredIssue(preset, name, entrypoint.type));
      return { name, type: entrypoint.type, ok: false };
    }
    const taskId = `task_PRESET_CHECK_${safeToken(manifest.id)}`;
    const smoke = runScriptHost({
      rootInput,
      commandName: "preset-check",
      script: {
        ...semanticPresetScriptEntry(semanticPreset, name, entrypoint),
        context: {
          presetId: manifest.id,
          presetTitle: manifest.title,
          entrypoint: name,
          taskId,
          validationSmoke: true
        }
      },
      inputs: syntheticSmokeInputs(entrypoint.inputs),
      outputRoot: taskPackagePath(rootInput, taskId),
      dryRun: true,
      allowFailedScriptResult: true,
      requireScriptResult: true
    });
    if (!smoke.ok) {
      const error = smoke.result.error;
      issues.push({
        code: error?.code === "script_not_found"
          ? "preset_entrypoint_script_missing"
          : error?.code === "preset_runtime_unavailable"
            ? "preset_entrypoint_runtime_unregistered"
            : "preset_entrypoint_smoke_failed",
        entrypoint: name,
        path: `entrypoints.${name}${error?.code === "script_not_found" ? ".command" : ""}`,
        message: `Entrypoint ${name} failed its semantic startup smoke: ${error?.hint ?? "unknown runtime failure"}`,
        nextCommand: error?.code === "script_not_found" ? repairCommand(preset) : smokeReproductionCommand(preset)
      });
    }
    return { name, type: entrypoint.type, command: entrypoint.command, ok: smoke.ok };
  });
  return { ok: issues.length === 0, entrypoints, issues };
}

function syntheticSmokeInputs(inputs: Readonly<Record<string, PresetInputV3>>): Record<string, string> {
  return Object.fromEntries(Object.entries(inputs).flatMap(([name, input]) => {
    if ("default" in input || "defaultFrom" in input) return [];
    if (!input.required) return [];
    if (input.type === "boolean") return [[name, "false"]];
    if (input.type === "integer") return [[name, "0"]];
    if (input.type === "enum" || input.type === "enum-list") return [[name, input.values[0] ?? ""]];
    if (input.type === "decision-ref") return [[name, "dec_PRESET_CHECK"]];
    if (input.type === "task-ref") return [[name, "task_PRESET_CHECK"]];
    return [[name, "preset-check"]];
  }));
}

function entrypointCapabilityUnregisteredIssue(
  preset: ResolvedPreset,
  entrypoint: string,
  type: "script" | "template"
): PresetEntrypointSmokeIssue {
  return {
    code: "preset_entrypoint_runtime_unregistered",
    entrypoint,
    path: `entrypoints.${entrypoint}`,
    message: `Entrypoint ${entrypoint} declares type ${type}, but the preset run capability registry does not expose that name. Registered names: ${presetRunEntrypointCapabilities.join(", ")}.`,
    nextCommand: "ha preset run --help"
  };
}

export function presetRuntimeRepairHint(preset: ResolvedPreset, issues: ReadonlyArray<PresetEntrypointSmokeIssue>): string {
  const first = issues[0];
  if (!first) return "";
  return `Preset ${preset.manifest.id} entrypoint ${first.entrypoint} is not runnable: ${first.message} Next: ${first.nextCommand}`;
}

function resolvedPresetScript(
  preset: ResolvedPreset,
  entrypointName: string,
  entrypoint: LegacyPresetScriptEntrypoint,
  taskId: string
): ResolvedScriptEntry {
  return {
    entry: legacyPresetScriptEntry(preset, entrypoint, entrypointName),
    verticalId: preset.manifest.vertical,
    manifestRoot: path.dirname(preset.sourcePath),
    owner: { id: preset.manifest.id, layer: preset.layer },
    context: {
      presetId: preset.manifest.id,
      presetTitle: preset.manifest.title,
      entrypoint: entrypointName,
      taskId,
      validationSmoke: true
    }
  };
}

function runtimeUnregisteredIssue(
  preset: ResolvedPreset,
  entrypoint: string,
  type: "template"
): PresetEntrypointSmokeIssue {
  return {
    code: "preset_entrypoint_runtime_unregistered",
    entrypoint,
    path: `entrypoints.${entrypoint}.type`,
    message: `Entrypoint ${entrypoint} declares type ${type}, but no ${type} entrypoint runtime is registered.`,
    nextCommand: repairCommand(preset)
  };
}

function repairCommand(preset: ResolvedPreset): string {
  if (preset.layer === "builtin" || preset.layer === "user") {
    return `run \`ha preset seed\`, then \`ha preset check ${preset.manifest.id}\``;
  }
  return `reinstall the complete preset package with \`ha preset install <preset-folder> --project\`, then run \`ha preset check ${preset.manifest.id}\``;
}

function smokeReproductionCommand(preset: ResolvedPreset): string {
  return `ha preset check ${preset.manifest.id} --json`;
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}
