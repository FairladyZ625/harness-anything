import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessLayoutInput, WriteOp } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import { resolveScriptPolicy } from "./preset-policy.ts";
import { buildPresetContextProjections } from "./preset-script-context.ts";
import { scriptChildEnvironment, type ScriptEnvironmentCapabilities } from "./script-environment.ts";
import { executeScript } from "./script-executor.ts";
import { trustedScriptRepositoryContext } from "./script-repository-context.ts";
import { invalidScriptOrPolicy, scriptFailure, validateResolvedScript } from "./script-host-validation.ts";
import { discoverPresets } from "./state.ts";
import {
  materializeSemanticPresetExecution,
  prepareSemanticPresetExecution,
  verifySemanticPresetOutputs,
  type PresetCapabilityRuntimeReceipt,
  type SemanticPresetExecution
} from "./preset-capability-runtime.ts";
import {
  isPathInside,
  permissionPathsForScope,
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
export type ScriptSource = "user" | "vertical" | "preset";
export type ScriptPurpose = "scaffold" | "generate" | "transform" | "audit";
export type ScriptKind = "action" | "check";

export interface ScriptEntry {
  readonly id: string;
  readonly source: ScriptSource;
  readonly type: "script";
  readonly command: string;
  readonly reads: ReadonlyArray<string>;
  readonly writes: ReadonlyArray<string>;
  readonly inputs: Record<string, unknown>;
  readonly metadata: {
    readonly description: string;
    readonly purpose: ScriptPurpose;
    readonly kind?: ScriptKind;
    readonly contractVersion: "script-entry/v1";
    readonly produces: ReadonlyArray<string>;
  };
}

export interface ResolvedScriptEntry {
  readonly entry: ScriptEntry;
  readonly verticalId: string;
  readonly manifestRoot: string;
  readonly owner?: unknown;
  readonly context?: Record<string, unknown>;
  readonly environmentCapabilities?: ScriptEnvironmentCapabilities;
  readonly trustedPackageReadPermissions?: ReadonlyArray<string>;
  readonly semantic?: SemanticPresetExecution;
}

export interface ScriptHostSuccess {
  readonly ok: true;
  readonly runId: string;
  readonly runDir: string;
  readonly generated: ReadonlyArray<string>;
  readonly scriptedResult: Record<string, unknown>;
  readonly capabilityReceipt?: PresetCapabilityRuntimeReceipt;
  readonly ingestOp?: WriteOp;
}

export type ScriptHostRunResult = ScriptHostSuccess | {
  readonly ok: false;
  readonly result: CliResult;
  readonly ingestOp?: WriteOp;
};
export function runScriptHost(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly script: ResolvedScriptEntry;
  readonly commandName: string;
  readonly inputs?: Record<string, string>;
  readonly outputRoot?: string;
  readonly dryRun?: boolean;
  readonly allowFailedScriptResult?: boolean;
  readonly requireScriptResult?: boolean;
}): ScriptHostRunResult {
  const layout = resolveHarnessLayout(options.rootInput);
  const validation = validateResolvedScript(options.script);
  const policy = resolveScriptPolicy(options.rootInput, discoverPresets(options.rootInput, options.script.verticalId), {
    source: options.script.entry.source,
    scriptId: options.script.entry.id,
    presetId: typeof options.script.context?.presetId === "string" ? options.script.context.presetId : undefined
  });
  if (!validation.ok || !policy.ok) return invalidScriptOrPolicy(options.commandName, validation, policy);
  const scriptPath = path.resolve(options.script.manifestRoot, options.script.entry.command);
  if (!isPathInside(options.script.manifestRoot, scriptPath) || !existsSync(scriptPath)) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptNotFound, "Script command was not found inside its manifest package.");
  }
  if (!scriptPackageIsSafe(scriptPath, options.script.manifestRoot)) {
    return scriptFailure(
      options.commandName,
      CliErrorCode.ScriptScopeInvalidRead,
      "Script manifest packages must contain only regular files and directories, never symbolic links."
    );
  }
  const syntax = spawnSync(process.execPath, ["--check", realpathSync.native(scriptPath)], {
    cwd: options.script.manifestRoot,
    encoding: "utf8",
    env: {}
  });
  if (syntax.status !== 0) {
    return scriptFailure(
      options.commandName,
      CliErrorCode.ScriptFailed,
      `Script command is not executable JavaScript: ${(syntax.stderr || syntax.stdout || "syntax check failed").trim()}`
    );
  }

  const fallbackOutputRoot = options.outputRoot ?? path.join(layout.authoredRoot, "context");
  const semanticPreparation = options.script.semantic
    ? prepareSemanticPresetExecution({
      rootInput: options.rootInput,
      execution: options.script.semantic,
      taskId: typeof options.script.context?.taskId === "string" ? options.script.context.taskId : undefined,
      runtimeInputs: options.inputs,
      fallbackOutputRoot,
      dryRun: options.dryRun
    })
    : undefined;
  if (semanticPreparation && !semanticPreparation.ok) {
    return scriptFailure(options.commandName, CliErrorCode.PresetRuntimeUnavailable, semanticPreparation.hint);
  }
  const preparedSemantic = semanticPreparation?.ok ? semanticPreparation.value : undefined;
  const outputRoot = preparedSemantic?.outputRoot ?? fallbackOutputRoot;
  const scopeOptions = reportsNoOverwriteLeafConflicts(options.script.entry)
    ? { reportLeafConflicts: true as const }
    : {};
  const readScope = preparedSemantic
    ? { ok: true as const, ...preparedSemantic.protectedSourceScopes }
    : options.script.entry.reads.length > 0
      ? resolveDeclaredReadScopes(options.script.entry.reads, layout, outputRoot, scopeOptions)
      : { ok: true as const, roots: [], permissions: [] };
  const writeScope = preparedSemantic
    ? { ok: true as const, ...preparedSemantic.stageEnvelope }
    : resolveDeclaredWriteScopes(options.script.entry.writes, layout, outputRoot, scopeOptions);
  if (!readScope.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidRead, "Script reads must declare supported project-local scopes.");
  if (!options.dryRun && !resolvedScopeSetIsSafe(readScope, layout.rootDir, "read")) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidRead, "Script read scopes must have safe filesystem boundaries.");
  }
  if (!writeScope.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidWrite, "Script writes must declare approved authored content scopes.");
  if (
    !preparedSemantic &&
    options.script.entry.source === "preset" &&
    options.outputRoot !== undefined &&
    options.script.entry.writes.length > 0 &&
    !writeScope.roots.some((allowedRoot) => isPathInside(allowedRoot, options.outputRoot!))
  ) {
    return scriptFailure(
      options.commandName,
      CliErrorCode.PresetWriteScopeInvalid,
      `Preset entrypoint ${options.script.entry.id} must declare a write scope covering its outputRoot. Next: fix entrypoint.writes, then run \`ha preset check ${String(options.script.context?.presetId ?? "<preset-id>")}\`.`
    );
  }

  const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(layout.localRoot, "script-runs", runId);
  const contextPath = path.join(runDir, "context.json");
  const resultPath = path.join(runDir, "result.json");

  // Keep governed physical-I/O callsites on their exact gate anchors.

  mkdirSync(runDir, { recursive: true });

  let stage: ReturnType<typeof createCanonicalScriptStage> | undefined;
  try {
    stage = !options.dryRun && writeScope.roots.length > 0
      ? createCanonicalScriptStage(options.rootInput, runDir, outputRoot, {
        protectedScopes: [
          { mode: "read", scope: readScope },
          { mode: "write", scope: writeScope }
        ]
      })
      : undefined;
  } catch (error) {
    if (!(error instanceof ScriptStageScopeError)) throw error;
    return scriptFailure(
      options.commandName,
      error.scopeMode === "read" ? CliErrorCode.ScriptScopeInvalidRead : CliErrorCode.ScriptScopeInvalidWrite,
      "Script staging scopes must not contain symbolic links."
    );
  }
  const executionLayout = stage?.layout ?? layout;
  const executionOutputRoot = stage?.outputRoot ?? outputRoot;
  const executionReadScope = stage
    ? remapScope(stage, readScope)
    : readScope;
  const executionWriteScope = stage
    ? remapScope(stage, writeScope, { retainOriginalPermissions: false })
    : writeScope;
  if (!executionReadScope.ok || !executionWriteScope.ok) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidWrite, "Script staging scopes could not be resolved.");
  }

  const semanticMaterialization = preparedSemantic && !options.dryRun
    ? materializeSemanticPresetExecution({
      rootInput: options.rootInput,
      preparation: preparedSemantic,
      stage,
      runDir,
      runId,
      resultPath
    })
    : undefined;
  if (semanticMaterialization && !semanticMaterialization.ok) {
    return scriptFailure(options.commandName, CliErrorCode.PresetRuntimeUnavailable, semanticMaterialization.hint, runDir, layout.rootDir);
  }
  const materializedSemantic = semanticMaterialization?.ok ? semanticMaterialization.value : undefined;
  if (preparedSemantic) {
    writeFileSync(contextPath, JSON.stringify(materializedSemantic?.context ?? {
      schema: "preset-context/v2",
      preset: {
        id: preparedSemantic.execution.preset.manifest.id,
        version: preparedSemantic.execution.preset.manifest.version,
        entrypoint: preparedSemantic.execution.entrypointName
      },
      run: { id: runId, taskId: preparedSemantic.currentTaskId, dryRun: true },
      inputs: preparedSemantic.inputs,
      capabilities: { reads: {}, writes: {} },
      result: { schema: "script-result/v1", path: resultPath },
      receipt: preparedSemantic.receipt
    }, null, 2), "utf8");
  } else {
    const mergedInputs = { ...options.script.entry.inputs, ...(options.inputs ?? {}) };
    const presetContextProjections = options.script.entry.source === "preset"
      ? buildPresetContextProjections({
        layout: executionLayout,
        outputRoot: executionOutputRoot,
        readRoots: executionReadScope.roots
      })
      : {};
    writeFileSync(contextPath, JSON.stringify({
      ...(options.script.context ?? {}),
      ...presetContextProjections,
      schema: options.script.entry.source === "preset" ? "preset-context/v1" : "script-context/v1",
      scriptId: options.script.entry.id,
      source: options.script.entry.source,
      runId,
      paths: {
        projectRoot: layout.rootDir,
        rootDir: executionLayout.rootDir,
        authoredRoot: executionLayout.authoredRoot,
        tasksRoot: executionLayout.tasksRoot,
        decisionsRoot: executionLayout.decisionsRoot,
        sessionsRoot: executionLayout.sessionsRoot,
        adrRoot: executionLayout.adrRoot,
        milestonesRoot: executionLayout.milestonesRoot,
        generatedRoot: executionLayout.generatedRoot,
        localRoot: executionLayout.localRoot
      },
      repository: trustedScriptRepositoryContext(layout.rootDir),
      inputs: mergedInputs,
      readScopes: executionReadScope.roots,
      writeScopes: executionWriteScope.roots,
      declaredScopeConflicts: {
        read: executionReadScope.reportedLeafConflicts ?? [],
        write: executionWriteScope.reportedLeafConflicts ?? []
      },
      resultPath,
      outputRoot: executionOutputRoot,
      policy: policy.policy
    }, null, 2), "utf8");
  }

  if (options.dryRun) {
    return {
      ok: true,
      runId,
      runDir,
      generated: [],
      scriptedResult: {
        schema: "script-result/v1",
        ok: true,
        report: { dryRun: true, scriptId: options.script.entry.id },
        produced: []
      }
    };
  }

  if (!scriptPackageIsSafe(scriptPath, options.script.manifestRoot)) {
    return scriptFailure(
      options.commandName,
      CliErrorCode.ScriptScopeInvalidRead,
      "Script manifest package changed to an unsafe filesystem shape before execution."
    );
  }
  const executionBoundaries = stage
    ? [executionLayout.rootDir, layout.rootDir]
    : [layout.rootDir];
  if (!resolvedScopeSetIsSafe(executionReadScope, executionBoundaries, "read")) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidRead, "Script read scope changed to an unsafe filesystem shape before execution.");
  }
  if (!resolvedScopeSetIsSafe(executionWriteScope, executionBoundaries, "write")) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidWrite, "Script write scope changed to an unsafe filesystem shape before execution.");
  }
  const execution = executeScript({
    scriptPath: realpathSync.native(scriptPath),
    cwd: options.script.manifestRoot,
    evidenceDir: runDir,
    outputRoot: executionOutputRoot,
    allowAddons: options.script.entry.metadata.kind === "check",
    allowChildProcess: isTrustedArchitectureToolScript(options.script, scriptPath),
    readPermissions: [
      ...scriptPackageReadPermissions(scriptPath, options.script.manifestRoot),
      ...(options.script.trustedPackageReadPermissions ?? []),
      contextPath,
      ...checkScriptPackageReadPermissions(options.script.entry.metadata.kind, options.script.manifestRoot, scriptPath, layout),
      ...architectureToolPackageReadPermissions(options.script, scriptPath, layout),
      ...(materializedSemantic?.childReadPermissions ?? executionReadScope.permissions)
    ],
    writePermissions: [
      resultPath,
      ...(materializedSemantic?.childWritePermissions ?? executionWriteScope.permissions),
      ...(preparedSemantic ? [] : checkScriptLocalWritePermissions(options.script.entry.metadata.kind, layout))
    ],
    env: scriptChildEnvironment({
      HARNESS_SCRIPT_CONTEXT: contextPath,
      HARNESS_SCRIPT_RESULT: resultPath,
      HARNESS_PRESET_CONTEXT: contextPath
    }, options.script.environmentCapabilities),
    artifactRoots: materializedSemantic?.writerRoots ?? executionWriteScope.roots,
    outputBoundary: {
      kind: "patterns",
      patterns: materializedSemantic?.outputPatterns ?? options.script.entry.metadata.produces,
      substitutions: materializedSemantic ? {} : producePatternSubstitutions(executionLayout, executionOutputRoot)
    }
  });
  writeFileSync(path.join(runDir, "stdout.txt"), execution.stdout, "utf8");
  writeFileSync(path.join(runDir, "stderr.txt"), execution.stderr, "utf8");
  if (!execution.ok) {
    if (execution.failure === "produced-outside-boundary") {
      return scriptFailure(
        options.commandName,
        CliErrorCode.ScriptDeclaredProduceMismatch,
        "Script produced files outside metadata.produces.",
        runDir,
        layout.rootDir
      );
    }
    return scriptFailure(
      options.commandName,
      execution.failure === "read-scope-violation"
        ? CliErrorCode.ScriptScopeViolationRead
        : execution.failure === "write-scope-violation"
          ? CliErrorCode.ScriptScopeViolationWrite
          : CliErrorCode.ScriptFailed,
      execution.failure === "read-scope-violation"
        ? "Script attempted filesystem read outside its declared permission scope."
        : execution.failure === "write-scope-violation"
          ? "Script attempted filesystem write outside its declared permission scope."
          : `Script exited with status ${execution.status ?? "unknown"}.`,
      runDir,
      layout.rootDir
    );
  }

  if (materializedSemantic) {
    const outputVerification = verifySemanticPresetOutputs(materializedSemantic.outputs);
    if (!outputVerification.ok) {
      return scriptFailure(options.commandName, CliErrorCode.ScriptDeclaredProduceMismatch, outputVerification.hint, runDir, layout.rootDir);
    }
  }

  const scriptedResult = readScriptResult(resultPath, options.script.entry.source === "preset" ? path.join(executionOutputRoot, "artifacts", "preset-result.json") : undefined, {
    allowMissingPresetResult: options.script.entry.source === "preset" && options.requireScriptResult !== true,
    scriptId: options.script.entry.id
  });
  if (!scriptedResult.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptResultInvalid, scriptedResult.hint, runDir, layout.rootDir);
  const declaredLeafConflicts = [
    ...(executionReadScope.reportedLeafConflicts ?? []),
    ...(executionWriteScope.reportedLeafConflicts ?? [])
  ];
  if (declaredLeafConflicts.length > 0 && (scriptedResult.value.ok !== false || execution.generated.length > 0)) {
    return scriptFailure(
      options.commandName,
      CliErrorCode.ScriptResultInvalid,
      "A no-overwrite scaffold with declared leaf conflicts must fail without producing files.",
      runDir,
      layout.rootDir
    );
  }
  const generatedPaths = stage ? canonicalGeneratedPaths(stage, execution.generated) : execution.generated;
  const ingestOp = stage ? scriptIngestOp(stage, materializedSemantic?.writerRoots ?? executionWriteScope.roots, runId) : undefined;
  const canonicalResult = stage ? canonicalizeScriptResult(stage, scriptedResult.value) : scriptedResult.value;
  if (scriptedResult.value.ok !== true && options.allowFailedScriptResult !== true) {
    const failure = scriptFailure(options.commandName, CliErrorCode.ScriptResultFailed, "Script reported a failed result.", runDir, layout.rootDir);
    const failedAuditIngestOp = options.script.entry.metadata.purpose === "audit" ? ingestOp : undefined;
    return {
      ok: false,
      result: {
        ...failure.result,
        runId,
        generated: failedAuditIngestOp
          ? generatedPaths.map((filePath) => relativeToRoot(layout.rootDir, filePath))
          : [],
        warnings: Array.isArray(canonicalResult.warnings) ? canonicalResult.warnings : undefined,
        rows: typeof canonicalResult.rows === "number" ? canonicalResult.rows : undefined,
        report: canonicalResult.report ?? canonicalResult
      },
      ...(failedAuditIngestOp ? { ingestOp: failedAuditIngestOp } : {})
    };
  }
  return {
    ok: true,
    runId,
    runDir,
    generated: generatedPaths.map((filePath) => relativeToRoot(layout.rootDir, filePath)),
    scriptedResult: canonicalResult,
    ...(preparedSemantic ? { capabilityReceipt: preparedSemantic.receipt } : {}),
    ...(ingestOp ? { ingestOp } : {})
  };
}

function reportsNoOverwriteLeafConflicts(entry: ScriptEntry): boolean {
  return entry.metadata.purpose === "scaffold" &&
    entry.writes.length > 0 &&
    entry.writes.every((scope) => scope.endsWith("/**") && entry.reads.includes(scope));
}

function readScriptResult(
  resultPath: string,
  presetResultPath: string | undefined,
  options: { readonly allowMissingPresetResult: boolean; readonly scriptId: string }
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly hint: string } {
  if (!existsSync(resultPath)) {
    const presetResult = readPresetScriptResult(presetResultPath);
    if (presetResult) return presetResult;
    if (options.allowMissingPresetResult) {
      return {
        ok: true,
        value: {
          schema: "script-result/v1",
          ok: true,
          report: { scriptId: options.scriptId },
          produced: []
        }
      };
    }
    return { ok: false, hint: "Script did not write script-result/v1 result.json." };
  }
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, hint: "Script result must be a JSON object." };
    const result = parsed as Record<string, unknown>;
    if (result.schema !== "script-result/v1" || typeof result.ok !== "boolean") return { ok: false, hint: "Script result schema must be script-result/v1 with boolean ok." };
    return { ok: true, value: result };
  } catch {
    return { ok: false, hint: "Script wrote invalid result.json." };
  }
}

function readPresetScriptResult(
  resultPath: string | undefined
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly hint: string } | undefined {
  if (!resultPath || !existsSync(resultPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, hint: "Preset script result must be a JSON object." };
    }
    const presetResult = parsed as Record<string, unknown>;
    if (typeof presetResult.ok !== "boolean") {
      return { ok: false, hint: "Preset script result must declare boolean ok." };
    }
    return { ok: true, value: {
      schema: "script-result/v1",
      ok: presetResult.ok,
      report: presetResult.report ?? presetResult,
      warnings: presetResult.warnings,
      rows: presetResult.rows,
      produced: presetResult.produced ?? []
    } };
  } catch {
    return { ok: false, hint: "Preset script wrote invalid artifacts/preset-result.json." };
  }
}

function producePatternSubstitutions(
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string
): Readonly<Record<string, string>> {
  return {
    "{{paths.authoredRoot}}": layout.authoredRoot,
    "{{paths.contextRoot}}": layout.contextRoot,
    "{{paths.tasksRoot}}": layout.tasksRoot,
    "{{paths.decisionsRoot}}": layout.decisionsRoot,
    "{{paths.sessionsRoot}}": layout.sessionsRoot,
    "{{paths.adrRoot}}": layout.adrRoot,
    "{{paths.milestonesRoot}}": layout.milestonesRoot,
    "{{outputRoot}}": outputRoot
  };
}

function relativeToRoot(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function checkScriptPackageReadPermissions(
  kind: ScriptKind | undefined,
  manifestRoot: string,
  scriptPath: string,
  layout: ReturnType<typeof resolveHarnessLayout>
): ReadonlyArray<string> {
  if (kind !== "check") return [];
  const kernelRoot = path.resolve(manifestRoot, "../../../../../../kernel");
  return [
    path.join(layout.rootDir, "package.json"),
    kernelRoot,
    `${kernelRoot}/**`,
    ...nodeModuleReadPermissions([path.dirname(scriptPath), manifestRoot, layout.rootDir])
  ];
}

function nodeModuleReadPermissions(startDirs: ReadonlyArray<string>): ReadonlyArray<string> {
  const roots = new Set<string>();
  for (const startDir of startDirs) {
    let current = path.resolve(startDir);
    while (current !== path.dirname(current)) {
      if (path.basename(current) === "node_modules" && existsSync(current)) roots.add(current);
      const nested = path.join(current, "node_modules");
      if (existsSync(nested)) roots.add(nested);
      current = path.dirname(current);
    }
    const rootNested = path.join(current, "node_modules");
    if (existsSync(rootNested)) roots.add(rootNested);
  }
  return [...roots].flatMap((root) => [root, `${root}/**`]);
}

function checkScriptLocalWritePermissions(kind: ScriptKind | undefined, layout: ReturnType<typeof resolveHarnessLayout>): ReadonlyArray<string> {
  if (kind !== "check") return [];
  return [
    layout.cacheRoot,
    `${layout.cacheRoot}/**`
  ];
}

function architectureToolPackageReadPermissions(
  script: ResolvedScriptEntry,
  scriptPath: string,
  layout: ReturnType<typeof resolveHarnessLayout>
): ReadonlyArray<string> {
  return isTrustedArchitectureToolScript(script, scriptPath)
    ? [
        ...permissionPathsForScope(path.dirname(layout.rootDir), false),
        ...permissionPathsForScope(layout.rootDir, true),
        ...nodeModuleReadPermissions([path.dirname(scriptPath), script.manifestRoot, layout.rootDir])
      ]
    : [];
}

function isTrustedArchitectureToolScript(script: ResolvedScriptEntry, scriptPath: string): boolean {
  const bundledRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "software-coding");
  const expectedCommands = new Map([
    ["vertical:software-coding:architecture-snapshot", "scripts/architecture-snapshot.mjs"],
    ["vertical:software-coding:architecture-check", "scripts/architecture-check.mjs"]
  ]);
  const expectedCommand = expectedCommands.get(script.entry.id);
  return script.entry.source === "vertical" &&
    script.verticalId === "software/coding" &&
    expectedCommand !== undefined &&
    script.entry.command === expectedCommand &&
    path.resolve(script.manifestRoot) === path.resolve(bundledRoot) &&
    path.resolve(scriptPath) === path.resolve(bundledRoot, expectedCommand);
}
