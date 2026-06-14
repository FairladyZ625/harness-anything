import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import { PresetManifestSchema } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, taskPackagePath } from "../../../../kernel/src/layout/index.ts";
import type { CliResult } from "../../cli/types.ts";
import type { ResolvedPreset } from "./state.ts";
import {
  isPathInside,
  listGeneratedFiles,
  permissionPathsForScope,
  resolveDeclaredReadScopes,
  resolveDeclaredWriteScopes,
  uniquePermissionPaths
} from "./script-scope.ts";

type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;
type ScriptEntrypoint = Extract<NonNullable<PresetManifest["entrypoints"]>[string], { readonly type: "script" }>;

export function runScriptEntrypoint(
  rootDir: string,
  preset: ResolvedPreset,
  presetSummary: unknown,
  entrypoint: ScriptEntrypoint,
  entrypointName: string,
  taskId: string,
  evidenceDir: string,
  commandName: "preset-run" | "preset-action"
): { readonly ok: true; readonly generated: ReadonlyArray<string>; readonly scriptedResult?: Record<string, unknown> } | { readonly ok: false; readonly result: CliResult } {
  const presetRoot = path.dirname(preset.sourcePath);
  const scriptPath = path.resolve(presetRoot, entrypoint.command);
  if (!isPathInside(presetRoot, scriptPath) || !existsSync(scriptPath)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: { code: "preset_script_not_found", hint: "Preset script entrypoint was not found inside the preset package." }
      }
    };
  }
  const layout = resolveHarnessLayout(rootDir);
  const outputRoot = taskPackagePath(rootDir, taskId);
  const writeScope = resolveDeclaredWriteScopes(entrypoint.writes, layout, outputRoot);
  const readScope = entrypoint.reads
    ? resolveDeclaredReadScopes(entrypoint.reads, layout, outputRoot)
    : { ok: true as const, roots: [], permissions: [] };
  if (!readScope.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: { code: "preset_read_scope_invalid", hint: "Preset script reads must declare supported project-local scopes." }
      }
    };
  }
  if (!writeScope.ok || !writeScope.roots.some((allowedRoot) => isPathInside(allowedRoot, outputRoot))) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        error: { code: "preset_write_scope_invalid", hint: "Preset script writes must declare a supported scope that covers the generated output root." }
      }
    };
  }
  mkdirSync(outputRoot, { recursive: true });
  const contextPath = path.join(evidenceDir, "context.json");
  writeFileSync(contextPath, JSON.stringify({
    schema: "preset-context/v1",
    presetId: preset.manifest.id,
    presetTitle: preset.manifest.title,
    entrypoint: entrypointName,
    taskId,
    paths: {
      rootDir: layout.rootDir,
      authoredRoot: layout.authoredRoot,
      tasksRoot: layout.tasksRoot,
      generatedRoot: layout.generatedRoot,
      localRoot: layout.localRoot
    },
    inputs: entrypoint.inputs ?? {},
    readScopes: readScope.roots,
    writeScopes: writeScope.roots,
    outputRoot
  }, null, 2), "utf8");
  const beforeFiles = new Set(listGeneratedFiles(outputRoot));
  const readablePaths = uniquePermissionPaths([
    ...permissionPathsForScope(presetRoot, true),
    contextPath,
    ...readScope.permissions
  ]);
  const writablePaths = uniquePermissionPaths(writeScope.permissions);
  const result = spawnSync(process.execPath, [
    "--permission",
    ...readablePaths.map((allowedPath) => `--allow-fs-read=${allowedPath}`),
    ...writablePaths.map((allowedPath) => `--allow-fs-write=${allowedPath}`),
    scriptPath
  ], {
    cwd: presetRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_PRESET_CONTEXT: contextPath
    }
  });
  writeFileSync(path.join(evidenceDir, "stdout.txt"), result.stdout ?? "", "utf8");
  writeFileSync(path.join(evidenceDir, "stderr.txt"), result.stderr ?? "", "utf8");
  if (result.status !== 0) {
    const permissionOutput = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    const accessDenied = permissionOutput.includes("ERR_ACCESS_DENIED");
    const readDenied = accessDenied && permissionOutput.includes("FileSystemRead");
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
        error: accessDenied
          ? readDenied
            ? { code: "preset_read_scope_violation", hint: "Preset script attempted filesystem read outside its declared permission scope." }
            : { code: "preset_write_scope_violation", hint: "Preset script attempted filesystem write outside its declared permission scope." }
          : { code: "preset_script_failed", hint: `Preset script exited with status ${result.status ?? "unknown"}.` }
      }
    };
  }
  const generatedFiles = listGeneratedFiles(outputRoot);
  const outOfScope = generatedFiles.filter((filePath) => !writeScope.roots.some((allowedRoot) => isPathInside(allowedRoot, filePath)));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      result: {
        ok: false,
        command: commandName,
        preset: presetSummary,
        evidenceBundle: path.relative(rootDir, evidenceDir).split(path.sep).join("/"),
        generated: generatedFiles.map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/")),
        error: { code: "preset_write_scope_violation", hint: "Preset script produced files outside its declared write scopes." }
      }
    };
  }
  return {
    ok: true,
    generated: generatedFiles
      .filter((filePath) => !beforeFiles.has(filePath))
      .map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/")),
    scriptedResult: readScriptedResult(outputRoot)
  };
}

export function scriptCliResult(options: {
  readonly rootDir: string;
  readonly evidenceDir: string;
  readonly commandName: "preset-run" | "preset-action";
  readonly preset: unknown;
  readonly generated: ReadonlyArray<string>;
  readonly scriptedResult: Record<string, unknown>;
}): CliResult {
  const ok = options.scriptedResult.ok === true;
  const report = options.scriptedResult.report ?? options.scriptedResult;
  return {
    ok,
    command: options.commandName,
    preset: options.preset,
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
    if (typeof error.code === "string" && typeof error.hint === "string") {
      return { code: error.code, hint: error.hint };
    }
  }
  return { code: "preset_script_result_failed", hint: "Preset script reported a failed result." };
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
      error: {
        code: "preset_script_result_invalid",
        hint: "Preset script wrote invalid artifacts/preset-result.json."
      }
    };
  }
}
