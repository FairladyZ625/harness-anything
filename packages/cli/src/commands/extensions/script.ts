import path from "node:path";
import type { HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout, taskPackagePath } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { bundledVerticalDefinitionEntry } from "./bundled.ts";
import { discoverPresets, publicPresetSummary } from "./state.ts";
import { presetScriptEntry } from "./preset-script-runner.ts";
import { runScriptHost, scriptHostCliResult, type ResolvedScriptEntry, type ScriptPurpose, type ScriptSource } from "./script-host.ts";

type ScriptAction = Extract<ParsedCommand["action"], {
  readonly kind: "script-list" | "script-inspect" | "script-run";
}>;

export function runScriptCommand(rootInput: HarnessLayoutInput, action: ScriptAction): CliResult {
  switch (action.kind) {
    case "script-list":
      return runScriptList(rootInput, action);
    case "script-inspect":
      return runScriptInspect(rootInput, action.scriptId);
    case "script-run":
      return runScriptRun(rootInput, action);
  }
}

function runScriptList(rootInput: HarnessLayoutInput, action: Extract<ScriptAction, { readonly kind: "script-list" }>): CliResult {
  const scripts = discoverScriptEntries(rootInput)
    .filter((script) => !action.source || script.entry.source === action.source)
    .filter((script) => !action.purpose || script.entry.metadata.purpose === action.purpose)
    .map(publicScriptSummary);
  return {
    ok: true,
    command: "script-list",
    scripts,
    rows: scripts.length
  };
}

function runScriptInspect(rootInput: HarnessLayoutInput, scriptId: string): CliResult {
  const script = resolveScript(rootInput, scriptId);
  if (!script) return scriptNotFound("script-inspect", scriptId);
  return {
    ok: true,
    command: "script-inspect",
    script: publicScriptDetails(script)
  };
}

function runScriptRun(rootInput: HarnessLayoutInput, action: Extract<ScriptAction, { readonly kind: "script-run" }>): CliResult {
  const script = resolveScript(rootInput, action.scriptId);
  if (!script) return scriptNotFound("script-run", action.scriptId);
  const layout = resolveHarnessLayout(rootInput);
  if (script.entry.source === "preset" && !action.taskId && !action.dryRun) {
    return {
      ok: false,
      command: "script-run",
      script: publicScriptSummary(script),
      error: cliError(CliErrorCode.ScriptContractInvalid, "Preset script run requires --task <id> unless --dry-run is used.")
    };
  }
  const outputRoot = action.taskId ? taskPackagePath(rootInput, action.taskId) : undefined;
  const run = runScriptHost({
    rootInput,
    commandName: "script-run",
    script: action.taskId ? {
      ...script,
      context: {
        ...(script.context ?? {}),
        taskId: action.taskId,
        outputRoot
      }
    } : script,
    inputs: action.inputs,
    outputRoot,
    dryRun: action.dryRun
  });
  if (!run.ok) return run.result;
  return scriptHostCliResult({
    rootDir: layout.rootDir,
    commandName: "script-run",
    script: publicScriptSummary(script),
    run
  });
}

export function discoverScriptEntries(rootInput: HarnessLayoutInput): ReadonlyArray<ResolvedScriptEntry> {
  const vertical = bundledVerticalDefinitionEntry();
  const verticalScripts = (vertical?.manifest.scripts ?? []).map((script): ResolvedScriptEntry => ({
    entry: {
      ...script,
      source: "vertical"
    },
    manifestRoot: vertical ? path.dirname(vertical.sourcePath) : "",
    owner: vertical ? {
      id: vertical.manifest.id,
      title: vertical.manifest.title,
      version: vertical.manifest.version,
      source: "vertical"
    } : undefined,
    context: vertical ? {
      verticalId: vertical.manifest.id,
      verticalTitle: vertical.manifest.title
    } : undefined
  }));
  const presetScripts = discoverPresets(rootInput)
    .flatMap((preset) => Object.entries(preset.manifest.entrypoints ?? {})
      .flatMap(([entrypointName, entrypoint]) => entrypoint.type === "script"
        ? [{
          entry: presetScriptEntry(preset, entrypoint, entrypointName),
          manifestRoot: path.dirname(preset.sourcePath),
          owner: publicPresetSummary(preset),
          context: {
            presetId: preset.manifest.id,
            presetTitle: preset.manifest.title,
            entrypoint: entrypointName
          }
        }]
        : []));
  return [...verticalScripts, ...presetScripts].sort((left, right) => left.entry.id.localeCompare(right.entry.id));
}

function resolveScript(rootInput: HarnessLayoutInput, scriptId: string): ResolvedScriptEntry | undefined {
  return discoverScriptEntries(rootInput).find((script) => script.entry.id === scriptId);
}

function publicScriptSummary(script: ResolvedScriptEntry): Record<string, unknown> {
  return {
    id: script.entry.id,
    source: script.entry.source,
    description: script.entry.metadata.description,
    purpose: script.entry.metadata.purpose,
    contractVersion: script.entry.metadata.contractVersion
  };
}

function publicScriptDetails(script: ResolvedScriptEntry): Record<string, unknown> {
  return {
    ...publicScriptSummary(script),
    command: script.entry.command,
    reads: script.entry.reads,
    writes: script.entry.writes,
    inputs: script.entry.inputs,
    metadata: script.entry.metadata,
    owner: script.owner
  };
}

function scriptNotFound(command: string, scriptId: string): CliResult {
  return {
    ok: false,
    command,
    error: cliError(CliErrorCode.ScriptNotFound, `Script ${scriptId} was not found.`)
  };
}

export function isScriptSource(value: string): value is ScriptSource {
  return value === "user" || value === "vertical" || value === "preset";
}

export function isScriptPurpose(value: string): value is ScriptPurpose {
  return value === "scaffold" || value === "generate" || value === "transform" || value === "audit";
}
