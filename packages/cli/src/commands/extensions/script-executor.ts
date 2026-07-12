import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeMachineEvidenceRegistry } from "./machine-evidence-registry.ts";
import { isPathInside, listGeneratedFiles, uniquePermissionPaths } from "./script-scope.ts";

export type ScriptExecutionFailure =
  | "read-scope-violation"
  | "write-scope-violation"
  | "execution-failed"
  | "produced-outside-boundary";

export interface ScriptExecutorOptions {
  readonly scriptPath: string;
  readonly cwd: string;
  readonly evidenceDir: string;
  readonly outputRoot: string;
  readonly readPermissions: ReadonlyArray<string>;
  readonly writePermissions: ReadonlyArray<string>;
  readonly allowAddons?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly artifactRoots: ReadonlyArray<string>;
  readonly outputBoundary:
    | { readonly kind: "roots"; readonly roots: ReadonlyArray<string>; readonly inspect: "all" | "generated" }
    | { readonly kind: "patterns"; readonly patterns: ReadonlyArray<string>; readonly substitutions: Readonly<Record<string, string>> };
}

export type ScriptExecutionResult =
  | {
    readonly ok: true;
    readonly generated: ReadonlyArray<string>;
    readonly stdout: string;
    readonly stderr: string;
  }
  | {
    readonly ok: false;
    readonly failure: ScriptExecutionFailure;
    readonly status: number | null;
    readonly generated?: ReadonlyArray<string>;
    readonly stdout: string;
    readonly stderr: string;
  };

export function executeScript(options: ScriptExecutorOptions): ScriptExecutionResult {
  const beforeFiles = snapshotArtifactFiles(options.artifactRoots);
  const result = spawnSync(process.execPath, [
    "--permission",
    ...(options.allowAddons ? ["--allow-addons"] : []),
    ...uniquePermissionPaths(options.readPermissions).map((allowedPath) => `--allow-fs-read=${allowedPath}`),
    ...uniquePermissionPaths(options.writePermissions).map((allowedPath) => `--allow-fs-write=${allowedPath}`),
    options.scriptPath
  ], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.status !== 0) {
    const output = `${stderr}\n${stdout}`;
    const accessDenied = output.includes("ERR_ACCESS_DENIED");
    return {
      ok: false,
      failure: accessDenied
        ? output.includes("FileSystemRead") ? "read-scope-violation" : "write-scope-violation"
        : "execution-failed",
      status: result.status,
      stdout,
      stderr
    };
  }

  const afterFiles = snapshotArtifactFiles(options.artifactRoots);
  const generated = [...afterFiles.keys()].filter((filePath) => beforeFiles.get(filePath) !== afterFiles.get(filePath));
  const boundaryCandidates = options.outputBoundary.kind === "roots" && options.outputBoundary.inspect === "all"
    ? [...afterFiles.keys()]
    : generated;
  if (!boundaryCandidates.every((filePath) => isAllowedOutput(filePath, options.outputBoundary))) {
    return {
      ok: false,
      failure: "produced-outside-boundary",
      status: result.status,
      generated: boundaryCandidates,
      stdout,
      stderr
    };
  }
  writeMachineEvidenceRegistry(options.outputRoot, generated);
  return { ok: true, generated, stdout, stderr };
}

function listArtifactFiles(roots: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(roots.flatMap((root) => listGeneratedFiles(root)))].sort();
}

function snapshotArtifactFiles(roots: ReadonlyArray<string>): ReadonlyMap<string, string> {
  return new Map(listArtifactFiles(roots).map((filePath) => [
    filePath,
    createHash("sha256").update(readFileSync(filePath)).digest("hex")
  ]));
}

function isAllowedOutput(filePath: string, boundary: ScriptExecutorOptions["outputBoundary"]): boolean {
  if (boundary.kind === "roots") {
    return boundary.roots.some((root) => path.resolve(root) === path.resolve(filePath) || isPathInside(root, filePath));
  }
  return boundary.patterns.some((pattern) => patternMatches(filePath, resolvePattern(pattern, boundary.substitutions)));
}

function resolvePattern(pattern: string, substitutions: Readonly<Record<string, string>>): string {
  return path.resolve(Object.entries(substitutions).reduce(
    (resolved, [token, value]) => resolved.replaceAll(token, value),
    pattern
  ));
}

function patternMatches(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) return isPathInside(pattern.slice(0, -3), filePath);
  if (!pattern.includes("*")) return path.resolve(filePath) === path.resolve(pattern);
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^/]*");
  return new RegExp(`^${escaped}$`, "u").test(path.resolve(filePath));
}
