import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HarnessLayoutInput } from "../../../../kernel/src/layout/index.ts";
import { resolveHarnessLayout } from "../../../../kernel/src/layout/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import {
  isPathInside,
  listGeneratedFiles,
  permissionPathsForScope,
  resolveDeclaredReadScopes,
  resolveDeclaredWriteScopes,
  uniquePermissionPaths
} from "./script-scope.ts";

export type ScriptSource = "user" | "vertical" | "preset";
export type ScriptPurpose = "scaffold" | "generate" | "transform" | "audit";

export interface ScriptEntry {
  readonly id: string;
  readonly source: ScriptSource;
  readonly type: "script";
  readonly command: string;
  readonly reads: ReadonlyArray<string>;
  readonly writes: ReadonlyArray<string>;
  readonly inputs: Record<string, string>;
  readonly metadata: {
    readonly description: string;
    readonly purpose: ScriptPurpose;
    readonly contractVersion: "script-entry/v1";
    readonly produces: ReadonlyArray<string>;
  };
}

export interface ResolvedScriptEntry {
  readonly entry: ScriptEntry;
  readonly manifestRoot: string;
  readonly owner?: unknown;
  readonly context?: Record<string, unknown>;
}

export interface ScriptHostSuccess {
  readonly ok: true;
  readonly runId: string;
  readonly runDir: string;
  readonly generated: ReadonlyArray<string>;
  readonly scriptedResult: Record<string, unknown>;
}

export type ScriptHostRunResult = ScriptHostSuccess | { readonly ok: false; readonly result: CliResult };

export function runScriptHost(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly script: ResolvedScriptEntry;
  readonly commandName: string;
  readonly inputs?: Record<string, string>;
  readonly outputRoot?: string;
  readonly dryRun?: boolean;
}): ScriptHostRunResult {
  const layout = resolveHarnessLayout(options.rootInput);
  const validation = validateResolvedScript(options.script);
  if (!validation.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptContractInvalid, validation.hint);

  const scriptPath = path.resolve(options.script.manifestRoot, options.script.entry.command);
  if (!isPathInside(options.script.manifestRoot, scriptPath) || !existsSync(scriptPath)) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptNotFound, "Script command was not found inside its manifest package.");
  }

  const outputRoot = options.outputRoot ?? path.join(layout.authoredRoot, "context");
  const readScope = options.script.entry.reads.length > 0
    ? resolveDeclaredReadScopes(options.script.entry.reads, layout, outputRoot)
    : { ok: true as const, roots: [], permissions: [] };
  const writeScope = resolveDeclaredWriteScopes(options.script.entry.writes, layout, outputRoot);
  if (!readScope.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidRead, "Script reads must declare supported project-local scopes.");
  if (!writeScope.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptScopeInvalidWrite, "Script writes must declare approved authored content scopes.");

  const runId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(layout.localRoot, "script-runs", runId);
  const contextPath = path.join(runDir, "context.json");
  const resultPath = path.join(runDir, "result.json");
  mkdirSync(runDir, { recursive: true });

  const mergedInputs = { ...options.script.entry.inputs, ...(options.inputs ?? {}) };
  writeFileSync(contextPath, JSON.stringify({
    schema: options.script.entry.source === "preset" ? "preset-context/v1" : "script-context/v1",
    scriptId: options.script.entry.id,
    source: options.script.entry.source,
    runId,
    paths: {
      rootDir: layout.rootDir,
      authoredRoot: layout.authoredRoot,
      tasksRoot: layout.tasksRoot,
      decisionsRoot: layout.decisionsRoot,
      sessionsRoot: layout.sessionsRoot,
      adrRoot: layout.adrRoot,
      milestonesRoot: layout.milestonesRoot,
      generatedRoot: layout.generatedRoot,
      localRoot: layout.localRoot
    },
    inputs: mergedInputs,
    readScopes: readScope.roots,
    writeScopes: writeScope.roots,
    resultPath,
    outputRoot,
    ...(options.script.context ?? {})
  }, null, 2), "utf8");

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

  const beforeFiles = snapshotFiles(writeScope.roots);
  const result = spawnSync(process.execPath, [
    "--permission",
    ...uniquePermissionPaths([
      ...ancestorDirectories(scriptPath),
      ...permissionPathsForScope(options.script.manifestRoot, true),
      contextPath,
      ...readScope.permissions
    ]).map((allowedPath) => `--allow-fs-read=${allowedPath}`),
    ...uniquePermissionPaths([
      resultPath,
      ...writeScope.permissions
    ]).map((allowedPath) => `--allow-fs-write=${allowedPath}`),
    scriptPath
  ], {
    cwd: options.script.manifestRoot,
    encoding: "utf8",
    env: {
      HARNESS_SCRIPT_CONTEXT: contextPath,
      HARNESS_SCRIPT_RESULT: resultPath,
      HARNESS_PRESET_CONTEXT: contextPath
    }
  });
  writeFileSync(path.join(runDir, "stdout.txt"), result.stdout ?? "", "utf8");
  writeFileSync(path.join(runDir, "stderr.txt"), result.stderr ?? "", "utf8");

  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    const accessDenied = output.includes("ERR_ACCESS_DENIED");
    const readDenied = accessDenied && output.includes("FileSystemRead");
    return scriptFailure(
      options.commandName,
      accessDenied
        ? readDenied ? CliErrorCode.ScriptScopeViolationRead : CliErrorCode.ScriptScopeViolationWrite
        : CliErrorCode.ScriptFailed,
      accessDenied
        ? readDenied
          ? "Script attempted filesystem read outside its declared permission scope."
          : "Script attempted filesystem write outside its declared permission scope."
        : `Script exited with status ${result.status ?? "unknown"}.`,
      runDir,
      layout.rootDir
    );
  }

  const scriptedResult = readScriptResult(resultPath, options.script.entry.source === "preset" ? path.join(outputRoot, "artifacts", "preset-result.json") : undefined, {
    allowMissingPresetResult: options.script.entry.source === "preset",
    scriptId: options.script.entry.id
  });
  if (!scriptedResult.ok) return scriptFailure(options.commandName, CliErrorCode.ScriptResultInvalid, scriptedResult.hint, runDir, layout.rootDir);
  if (scriptedResult.value.ok !== true) return scriptFailure(options.commandName, CliErrorCode.ScriptResultFailed, "Script reported a failed result.", runDir, layout.rootDir);

  const generated = producedFilesSince(beforeFiles, snapshotFiles(writeScope.roots));
  if (!matchesDeclaredProduces(generated, options.script.entry.metadata.produces, layout, outputRoot)) {
    return scriptFailure(options.commandName, CliErrorCode.ScriptDeclaredProduceMismatch, "Script produced files outside metadata.produces.", runDir, layout.rootDir);
  }

  return {
    ok: true,
    runId,
    runDir,
    generated: generated.map((filePath) => relativeToRoot(layout.rootDir, filePath)),
    scriptedResult: scriptedResult.value
  };
}

export function scriptHostCliResult(options: {
  readonly rootDir: string;
  readonly commandName: string;
  readonly script: unknown;
  readonly run: ScriptHostSuccess;
}): CliResult {
  return {
    ok: true,
    command: options.commandName,
    script: options.script,
    runId: options.run.runId,
    evidenceBundle: relativeToRoot(options.rootDir, options.run.runDir),
    generated: options.run.generated,
    warnings: Array.isArray(options.run.scriptedResult.warnings) ? options.run.scriptedResult.warnings : undefined,
    rows: typeof options.run.scriptedResult.rows === "number" ? options.run.scriptedResult.rows : undefined,
    report: options.run.scriptedResult.report ?? options.run.scriptedResult
  };
}

function validateResolvedScript(script: ResolvedScriptEntry): { readonly ok: true } | { readonly ok: false; readonly hint: string } {
  const entry = script.entry;
  if (entry.type !== "script") return { ok: false, hint: "Script entry type must be script." };
  if (!entry.id || !entry.command) return { ok: false, hint: "Script entry id and command are required." };
  if (!["user", "vertical", "preset"].includes(entry.source)) return { ok: false, hint: "Script source is invalid." };
  if (entry.metadata.contractVersion !== "script-entry/v1") return { ok: false, hint: "Script metadata contractVersion must be script-entry/v1." };
  if (!entry.metadata.description || !entry.metadata.purpose || !Array.isArray(entry.metadata.produces)) {
    return { ok: false, hint: "Script metadata description, purpose, and produces are required." };
  }
  return { ok: true };
}

function scriptFailure(command: string, code: CliErrorCode, hint: string, runDir?: string, rootDir?: string): { readonly ok: false; readonly result: CliResult } {
  return {
    ok: false,
    result: {
      ok: false,
      command,
      evidenceBundle: runDir && rootDir ? relativeToRoot(rootDir, runDir) : undefined,
      error: cliError(code, hint)
    }
  };
}

function readScriptResult(
  resultPath: string,
  presetResultPath: string | undefined,
  options: { readonly allowMissingPresetResult: boolean; readonly scriptId: string }
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly hint: string } {
  if (!existsSync(resultPath)) {
    const presetResult = readPresetScriptResult(presetResultPath);
    if (presetResult) return { ok: true, value: presetResult };
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

function readPresetScriptResult(resultPath: string | undefined): Record<string, unknown> | undefined {
  if (!resultPath || !existsSync(resultPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const presetResult = parsed as Record<string, unknown>;
    return {
      schema: "script-result/v1",
      ok: presetResult.ok === true,
      report: presetResult.report ?? presetResult,
      warnings: presetResult.warnings,
      rows: presetResult.rows,
      produced: presetResult.produced ?? []
    };
  } catch {
    return {
      schema: "script-result/v1",
      ok: false,
      error: cliError(CliErrorCode.ScriptResultInvalid, "Preset script wrote invalid artifacts/preset-result.json.")
    };
  }
}

function snapshotFiles(roots: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(roots.flatMap((root) => listGeneratedFiles(root)));
}

function producedFilesSince(before: ReadonlySet<string>, after: ReadonlySet<string>): ReadonlyArray<string> {
  return [...after].filter((filePath) => !before.has(filePath)).sort();
}

function matchesDeclaredProduces(
  files: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
  layout: ReturnType<typeof resolveHarnessLayout>,
  outputRoot: string
): boolean {
  if (files.length === 0) return true;
  const resolvedPatterns = patterns.map((pattern) => resolveProducePattern(pattern, layout, outputRoot));
  return files.every((filePath) => resolvedPatterns.some((pattern) => patternMatches(filePath, pattern)));
}

function resolveProducePattern(pattern: string, layout: ReturnType<typeof resolveHarnessLayout>, outputRoot: string): string {
  return path.resolve(pattern
    .replaceAll("{{paths.authoredRoot}}", layout.authoredRoot)
    .replaceAll("{{paths.contextRoot}}", layout.contextRoot)
    .replaceAll("{{paths.tasksRoot}}", layout.tasksRoot)
    .replaceAll("{{paths.decisionsRoot}}", layout.decisionsRoot)
    .replaceAll("{{paths.sessionsRoot}}", layout.sessionsRoot)
    .replaceAll("{{paths.adrRoot}}", layout.adrRoot)
    .replaceAll("{{paths.milestonesRoot}}", layout.milestonesRoot)
    .replaceAll("{{outputRoot}}", outputRoot));
}

function patternMatches(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) return isPathInside(pattern.slice(0, -3), filePath);
  if (!pattern.includes("*")) return path.resolve(filePath) === path.resolve(pattern);
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*");
  return new RegExp(`^${escaped}$`, "u").test(path.resolve(filePath));
}

function relativeToRoot(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function ancestorDirectories(filePath: string): ReadonlyArray<string> {
  const ancestors: string[] = [];
  let current = path.dirname(path.resolve(filePath));
  while (current !== path.dirname(current)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  ancestors.push(current);
  return ancestors;
}
