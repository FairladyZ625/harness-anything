import { existsSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput, WriteOp } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, taskPackagePath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import { resolveActiveVertical } from "./active-vertical.ts";
import { discoverPresets, publicPresetSummary } from "./state.ts";
import { legacyPresetScriptEntry } from "./preset-script-runner.ts";
import { semanticPresetScriptEntry } from "./preset-capability-runtime.ts";
import { runScriptHost, type ResolvedScriptEntry, type ScriptKind, type ScriptPurpose, type ScriptSource } from "./script-host.ts";
import { scriptHostCliResult } from "./script-host-result.ts";

type ScriptAction = Extract<ParsedCommand["action"], {
  readonly kind: "script-list" | "script-inspect" | "script-run";
}>;

export function runScriptCommand(rootInput: HarnessLayoutInput, action: ScriptAction, pendingOps: WriteOp[]): CliResult {
  switch (action.kind) {
    case "script-list":
      return runScriptList(rootInput, action);
    case "script-inspect":
      return runScriptInspect(rootInput, action.scriptId);
    case "script-run":
      return runScriptRun(rootInput, action, pendingOps);
  }
}

function runScriptList(rootInput: HarnessLayoutInput, action: Extract<ScriptAction, { readonly kind: "script-list" }>): CliResult {
  const discovered = discoverScriptEntries(rootInput, "script-list");
  if (!discovered.ok) return discovered.result;
  const scripts = discovered.scripts
    .filter((script) => !action.source || script.entry.source === action.source)
    .filter((script) => !action.purpose || script.entry.metadata.purpose === action.purpose)
    .filter((script) => !action.scriptKind || (script.entry.metadata.kind ?? "action") === action.scriptKind)
    .map(publicScriptSummary);
  return {
    ok: true,
    command: "script-list",
    scripts,
    rows: scripts.length
  };
}

function runScriptInspect(rootInput: HarnessLayoutInput, scriptId: string): CliResult {
  const discovered = discoverScriptEntries(rootInput, "script-inspect");
  if (!discovered.ok) return discovered.result;
  const script = resolveScript(discovered.scripts, scriptId);
  if (!script) return scriptNotFound("script-inspect", scriptId);
  return {
    ok: true,
    command: "script-inspect",
    script: publicScriptDetails(script)
  };
}

function runScriptRun(rootInput: HarnessLayoutInput, action: Extract<ScriptAction, { readonly kind: "script-run" }>, pendingOps: WriteOp[]): CliResult {
  const discovered = discoverScriptEntries(rootInput, "script-run");
  if (!discovered.ok) return discovered.result;
  const script = resolveScript(discovered.scripts, action.scriptId);
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
  if (action.taskId && scriptUsesTaskOwnedArtifacts(script) && !action.dryRun) {
    const candidate = taskPackagePath(rootInput, action.taskId);
    if (!existsSync(path.join(candidate, "INDEX.md"))) {
      return {
        ok: false,
        command: "script-run",
        script: publicScriptSummary(script),
        error: cliError(CliErrorCode.TaskNotFound, `task not found: ${action.taskId}`)
      };
    }
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
  if (!run.ok) {
    if (run.ingestOp) pendingOps.push(run.ingestOp);
    return run.result;
  }
  if (run.ingestOp) pendingOps.push(run.ingestOp);
  return scriptHostCliResult({
    rootDir: layout.rootDir,
    commandName: "script-run",
    script: publicScriptSummary(script),
    run
  });
}

function scriptUsesTaskOwnedArtifacts(script: ResolvedScriptEntry): boolean {
  if (script.semantic) {
    return [...script.semantic.entrypoint.requires, ...script.semantic.entrypoint.produces]
      .some((request) => request.capability === "task-artifacts" || request.capability === "tasks");
  }
  return [
    ...script.entry.reads,
    ...script.entry.writes,
    ...script.entry.metadata.produces
  ].some((scope) => scope.startsWith("{{outputRoot}}/artifacts/") && scope.endsWith("/**"));
}

export function discoverScriptEntries(
  rootInput: HarnessLayoutInput,
  command: string
): { readonly ok: true; readonly scripts: ReadonlyArray<ResolvedScriptEntry> } | { readonly ok: false; readonly result: CliResult } {
  const activeVertical = resolveActiveVertical(rootInput, command);
  if (!activeVertical.ok) return activeVertical;

  const vertical = activeVertical.definition;
  const verticalScripts = vertical.manifest.scripts.map((script): ResolvedScriptEntry => ({
    entry: {
      ...script,
      source: "vertical"
    },
    verticalId: activeVertical.id,
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
  const presetScripts = discoverPresets(rootInput, activeVertical.id)
    .flatMap((preset) => Object.entries(preset.manifest.entrypoints ?? {})
      .flatMap(([entrypointName, entrypoint]) => {
        if (entrypoint.type !== "script") return [];
        if (preset.manifest.schema === "preset-manifest/v3") {
          return [semanticPresetScriptEntry({ ...preset, manifest: preset.manifest }, entrypointName, entrypoint)];
        }
        return [{
          entry: legacyPresetScriptEntry(preset, entrypoint, entrypointName),
          verticalId: activeVertical.id,
          manifestRoot: path.dirname(preset.sourcePath),
          owner: publicPresetSummary(preset),
          context: {
            presetId: preset.manifest.id,
            presetTitle: preset.manifest.title,
            entrypoint: entrypointName
          }
        }];
      }));
  return {
    ok: true,
    scripts: [...verticalScripts, ...presetScripts].sort((left, right) => left.entry.id.localeCompare(right.entry.id))
  };
}

function resolveScript(scripts: ReadonlyArray<ResolvedScriptEntry>, scriptId: string): ResolvedScriptEntry | undefined {
  return scripts.find((script) => script.entry.id === scriptId);
}

function publicScriptSummary(script: ResolvedScriptEntry): Record<string, unknown> {
  return {
    id: script.entry.id,
    source: script.entry.source,
    description: script.entry.metadata.description,
    purpose: script.entry.metadata.purpose,
    kind: script.entry.metadata.kind ?? "action",
    contractVersion: script.entry.metadata.contractVersion
  };
}

function publicScriptDetails(script: ResolvedScriptEntry): Record<string, unknown> {
  if (script.semantic) {
    return {
      ...publicScriptSummary(script),
      command: script.entry.command,
      intent: script.semantic.entrypoint.intent,
      inputs: script.semantic.entrypoint.inputs,
      requires: script.semantic.entrypoint.requires,
      produces: script.semantic.entrypoint.produces,
      sideEffects: script.semantic.entrypoint.sideEffects,
      metadata: script.entry.metadata,
      owner: script.owner
    };
  }
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

export function isScriptKind(value: string): value is ScriptKind {
  return value === "action" || value === "check";
}
