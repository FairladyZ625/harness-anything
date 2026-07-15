import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import { PresetManifestSchema } from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput, WriteOp } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, taskPackagePath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode, isCliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { ResolvedPreset } from "./state.ts";
import type { ScriptEntry } from "./script-host.ts";
import { resolveScriptPolicy, type PresetPolicyResolution } from "./preset-policy.ts";
import { buildPresetContext } from "./preset-script-context.ts";
import { scriptChildEnvironment } from "./script-environment.ts";
import { executeScript } from "./script-executor.ts";
import {
  isPathInside,
  resolvedScopeSetIsSafe,
  resolveDeclaredReadScopes,
  resolveDeclaredWriteScopes,
  scriptPackageIsSafe,
  scriptPackageReadPermissions
} from "./script-scope.ts";
import {
  canonicalGeneratedPaths,
  canonicalizeScriptResult,
  createCanonicalScriptStage,
  remapScope,
  ScriptStageScopeError,
  scriptIngestOp
} from "./script-staging.ts";
type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;
type LegacyPresetManifest = Exclude<PresetManifest, { readonly schema: "preset-manifest/v3" }>;
export type LegacyPresetScriptEntrypoint = Extract<NonNullable<LegacyPresetManifest["entrypoints"]>[string], { readonly type: "script" }>;

export function legacyPresetScriptEntry(preset: ResolvedPreset, entrypoint: LegacyPresetScriptEntrypoint, entrypointName: string): ScriptEntry {
  return {
    id: `preset:${preset.manifest.id}:${entrypointName}`,
    source: "preset",
    type: "script",
    command: entrypoint.command,
    reads: entrypoint.reads ?? [],
    writes: entrypoint.writes,
    inputs: entrypoint.inputs ?? {},
    metadata: {
      description: `${preset.manifest.title} ${entrypointName}`,
      purpose: presetScriptPurpose(entrypointName),
      contractVersion: "script-entry/v1",
      produces: entrypoint.writes
    }
  };
}

function presetScriptPurpose(entrypointName: string): ScriptEntry["metadata"]["purpose"] {
  if (entrypointName === "scaffold") return "scaffold";
  if (entrypointName === "check" || entrypointName === "audit") return "audit";
  return "generate";
}

export function runLegacyPresetScriptEntrypoint(
  rootInput: HarnessLayoutInput,
  preset: ResolvedPreset,
  presets: ReadonlyArray<ResolvedPreset>,
  presetSummary: unknown,
  entrypoint: LegacyPresetScriptEntrypoint,
  entrypointName: string,
  taskId: string,
  evidenceDir: string,
  commandName: "preset-run" | "preset-action",
  runtimeInputs: Record<string, string> = {}
): { readonly ok: true; readonly generated: ReadonlyArray<string>; readonly scriptedResult?: Record<string, unknown>; readonly ingestOp?: WriteOp } | { readonly ok: false; readonly result: CliResult } {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const presetRoot = path.dirname(preset.sourcePath);
  const scriptPath = path.resolve(presetRoot, entrypoint.command);
  if (!isPathInside(presetRoot, scriptPath) || !existsSync(scriptPath)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetScriptNotFound, "Preset script entrypoint was not found inside the preset package.")
      }
    };
  }
  if (!scriptPackageIsSafe(scriptPath, presetRoot)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetReadScopeInvalid, "Preset script packages must contain only regular files and directories, never symbolic links.")
      }
    };
  }
  const outputRoot = taskPackagePath(rootInput, taskId), policy = resolveRunnerScriptPolicy(rootInput, presets, preset);
  const writeScope = resolveDeclaredWriteScopes(entrypoint.writes, layout, outputRoot);
  const readScope = entrypoint.reads
    ? resolveDeclaredReadScopes(entrypoint.reads, layout, outputRoot)
    : { ok: true as const, roots: [], permissions: [] };
  if (!policy.ok || !readScope.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: policy.ok ? cliError(CliErrorCode.PresetReadScopeInvalid, "Preset script reads must declare supported project-local scopes.") : policy.error
      }
    };
  }
  if (!resolvedScopeSetIsSafe(readScope, layout.rootDir, "read")) {
    return invalidExecutionScope(commandName, presetSummary, "read");
  }
  if (!writeScope.ok || !writeScope.roots.some((allowedRoot) => isPathInside(allowedRoot, outputRoot))) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetWriteScopeInvalid, "Preset script writes must declare a supported scope that covers the generated output root.")
      }
    };
  }

  let stage: ReturnType<typeof createCanonicalScriptStage>;
  try {
    stage = createCanonicalScriptStage(rootInput, evidenceDir, outputRoot, {
      protectedScopes: [
        { mode: "read", scope: readScope },
        { mode: "write", scope: writeScope }
      ]
    });
  } catch (error) {
    if (!(error instanceof ScriptStageScopeError)) throw error;
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(
          error.scopeMode === "read" ? CliErrorCode.PresetReadScopeInvalid : CliErrorCode.PresetWriteScopeInvalid,
          "Preset script staging scopes must not contain symbolic links."
        )
      }
    };
  }
  const executionLayout = stage.layout;
  const executionOutputRoot = stage.outputRoot;
  const executionWriteScope = remapScope(stage, writeScope, { retainOriginalPermissions: false });
  const executionReadScope = remapScope(stage, readScope);
  mkdirSync(executionOutputRoot, { recursive: true });
  const contextPath = path.join(evidenceDir, "context.json");
  writeFileSync(contextPath, JSON.stringify(buildPresetContext({
    layout: executionLayout,
    projectRoot: stage.realLayout.rootDir,
    preset,
    entrypointName,
    taskId,
    inputs: { ...(entrypoint.inputs ?? {}), ...runtimeInputs },
    readRoots: executionReadScope.roots,
    writeRoots: executionWriteScope.roots,
    outputRoot: executionOutputRoot, policy: policy.policy
  }), null, 2), "utf8");
  const readablePaths = [
    ...scriptPackageReadPermissions(scriptPath, presetRoot),
    contextPath,
    ...executionReadScope.permissions
  ];
  if (!scriptPackageIsSafe(scriptPath, presetRoot)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: cliError(CliErrorCode.PresetReadScopeInvalid, "Preset script package changed to an unsafe filesystem shape before execution.")
      }
    };
  }
  const executionBoundaries = [executionLayout.rootDir, layout.rootDir];
  if (!resolvedScopeSetIsSafe(executionReadScope, executionBoundaries, "read")) {
    return invalidExecutionScope(commandName, presetSummary, "read");
  }
  if (!resolvedScopeSetIsSafe(executionWriteScope, executionBoundaries, "write")) {
    return invalidExecutionScope(commandName, presetSummary, "write");
  }
  const execution = executeScript({
    scriptPath: realpathSync.native(scriptPath),
    cwd: presetRoot,
    evidenceDir,
    outputRoot: executionOutputRoot,
    readPermissions: readablePaths,
    writePermissions: executionWriteScope.permissions,
    env: scriptChildEnvironment({
      HARNESS_PRESET_CONTEXT: contextPath
    }),
    artifactRoots: executionWriteScope.roots,
    outputBoundary: { kind: "roots", roots: executionWriteScope.roots, inspect: "all" }
  });

  writeFileSync(path.join(evidenceDir, "stdout.txt"), execution.stdout, "utf8");
  writeFileSync(path.join(evidenceDir, "stderr.txt"), execution.stderr, "utf8");
  if (!execution.ok) {
    const generated = execution.failure === "produced-outside-boundary"
      ? execution.generated?.map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/"))
      : undefined;
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
        generated,
        error: execution.failure === "read-scope-violation"
          ? cliError(CliErrorCode.PresetReadScopeViolation, "Preset script attempted filesystem read outside its declared permission scope.")
          : execution.failure === "write-scope-violation"
            ? cliError(CliErrorCode.PresetWriteScopeViolation, "Preset script attempted filesystem write outside its declared permission scope.")
            : execution.failure === "produced-outside-boundary"
              ? cliError(CliErrorCode.PresetWriteScopeViolation, "Preset script produced files outside its declared write scopes.")
              : cliError(CliErrorCode.PresetScriptFailed, `Preset script exited with status ${execution.status ?? "unknown"}.`)
      }
    };
  }
  const scriptedResult = readScriptedResult(executionOutputRoot);
  const failedScriptedResult = scriptedResult !== undefined && scriptedResult.ok !== true;
  const mayIngestFailedResult = presetScriptPurpose(entrypointName) === "audit";
  const shouldIngest = !failedScriptedResult || mayIngestFailedResult;
  const generated = shouldIngest
    ? canonicalGeneratedPaths(stage, execution.generated).map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/"))
    : [];
  const ingestOp = shouldIngest
    ? scriptIngestOp(stage, executionWriteScope.roots, path.basename(evidenceDir))
    : undefined;
  return {
    ok: true,
    generated,
    ...(scriptedResult ? { scriptedResult: canonicalizeScriptResult(stage, scriptedResult) } : {}),
    ...(ingestOp ? { ingestOp } : {})
  };
}

function invalidExecutionScope(
  command: "preset-run" | "preset-action",
  preset: unknown,
  mode: "read" | "write"
): { readonly ok: false; readonly result: CliResult } {
  return {
    ok: false,
    result: {
      ok: false,
      command,
      preset,
      error: cliError(
        mode === "read" ? CliErrorCode.PresetReadScopeInvalid : CliErrorCode.PresetWriteScopeInvalid,
        `Preset script ${mode} scope changed to an unsafe filesystem shape before execution.`
      )
    }
  };
}

function resolveRunnerScriptPolicy(
  rootInput: HarnessLayoutInput,
  presets: ReadonlyArray<ResolvedPreset>,
  preset: ResolvedPreset
): PresetPolicyResolution {
  for (const capability of preset.manifest.capabilityImports) {
    if (!capability.id.startsWith("vertical:")) continue;
    const verticalPolicy = resolveScriptPolicy(rootInput, presets, {
      source: "vertical",
      scriptId: capability.id
    });
    if (!verticalPolicy.ok) return verticalPolicy;
  }
  return resolveScriptPolicy(rootInput, presets, {
    source: "preset",
    scriptId: `preset:${preset.manifest.id}`,
    presetId: preset.manifest.id
  });
}

export function scriptCliResult(options: {
  readonly rootDir: string;
  readonly evidenceDir: string;
  readonly commandName: "preset-run" | "preset-action";
  readonly preset: unknown;
  readonly taskId: string;
  readonly generated: ReadonlyArray<string>;
  readonly scriptedResult: Record<string, unknown>;
}): CliResult {
  const ok = options.scriptedResult.ok === true;
  const report = options.scriptedResult.report ?? options.scriptedResult;
  return {
    ok,
    command: options.commandName,
    preset: options.preset,
    taskId: options.taskId,
    evidenceBundle: path.relative(options.rootDir, options.evidenceDir).split(path.sep).join("/"),
    generated: options.generated,
    warnings: Array.isArray(options.scriptedResult.warnings) ? options.scriptedResult.warnings : undefined,
    rows: typeof options.scriptedResult.rows === "number" ? options.scriptedResult.rows : undefined,
    report,
    error: ok ? undefined : scriptError(options.scriptedResult.error)
  };
}

function scriptError(value: unknown): CliResult["error"] {
  if (value && typeof value === "object" && "code" in value && "hint" in value) {
    const error = value as { readonly code?: unknown; readonly hint?: unknown };
    if (isCliErrorCode(error.code) && typeof error.hint === "string") {
      return cliError(error.code, error.hint);
    }
  }
  return cliError(CliErrorCode.PresetScriptResultFailed, "Preset script reported a failed result.");
}

function readScriptedResult(outputRoot: string): Record<string, unknown> | undefined {
  const resultPath = path.join(outputRoot, "artifacts", "preset-result.json");
  if (!existsSync(resultPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return {
      ok: false,
      error: cliError(CliErrorCode.PresetScriptResultInvalid, "Preset script wrote invalid artifacts/preset-result.json.")
    };
  }
}
