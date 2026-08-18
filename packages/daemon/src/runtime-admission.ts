import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLifecycleTaskProjectionPath, readTaskProjectionSchemaVersion, taskProjectionSchemaVersion } from "../../kernel/src/index.ts";

export class DaemonAdmissionError extends Error {
  readonly code: "daemon_build_stale" | "kernel_schema_mismatch";
  constructor(code: "daemon_build_stale" | "kernel_schema_mismatch", message: string) { super(message); this.name = "DaemonAdmissionError"; this.code = code; }
}

export function assertDaemonRuntimeAdmitted(rootDir: string, runtimeFile = fileURLToPath(import.meta.url)): void {
  const stale = staleDistFiles(runtimeFile);
  if (stale.length > 0) throw new DaemonAdmissionError("daemon_build_stale", `daemon build is behind source for ${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ` and ${stale.length - 3} more files` : ""}; stop the resident daemon, run npm run build -w @harness-anything/cli, then restart.`);
  const projectionPath = defaultLifecycleTaskProjectionPath(rootDir), observed = readTaskProjectionSchemaVersion(projectionPath);
  if (observed !== null && observed !== taskProjectionSchemaVersion) throw new DaemonAdmissionError("kernel_schema_mismatch", `kernel projection schema ${observed} does not match daemon schema ${taskProjectionSchemaVersion}; stop the daemon, remove ${projectionPath}, then restart so the projection is rebuilt.`);
}

export function staleDistFiles(runtimeFile: string): readonly string[] {
  const marker = `${path.sep}packages${path.sep}cli${path.sep}dist${path.sep}`;
  const markerAt = runtimeFile.indexOf(marker);
  if (markerAt < 0) return [];
  const workspaceRoot = runtimeFile.slice(0, markerAt), distRoot = path.join(workspaceRoot, "packages", "cli", "dist"), stale: string[] = [];
  for (const [packageName, sourceRoot] of [["cli", path.join(workspaceRoot, "packages", "cli", "src")], ["kernel", path.join(workspaceRoot, "packages", "kernel", "src")], ["daemon", path.join(workspaceRoot, "packages", "daemon", "src")], ["application", path.join(workspaceRoot, "packages", "application", "src")]] as const) {
    for (const source of walkTs(sourceRoot)) {
      const relative = path.relative(sourceRoot, source), output = path.join(distRoot, packageName, "src", relative.replace(/\.ts$/u, ".js"));
      if (!existsSync(output) || statSync(source).mtimeMs > statSync(output).mtimeMs + 1) stale.push(path.relative(workspaceRoot, source));
    }
  }
  return stale.sort();
}

function walkTs(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkTs(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}
