import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLifecycleTaskProjectionPath, readTaskProjectionSchemaVersion, taskProjectionSchemaVersion } from "../../kernel/src/index.ts";

export interface DaemonRuntimeAdmissionGuard { readonly assert: (rootDir: string, force?: boolean) => void }
interface RuntimeBuildBaseline { readonly markerPath: string; readonly loadedBuildId: string | null }
const runtimeBuildIdFilename = "build-id.txt", schemaAdmissionRecheckMs = 5_000, defaultRuntimeFile = fileURLToPath(import.meta.url), processBuildBaseline = runtimeBuildBaseline(defaultRuntimeFile);

export class DaemonAdmissionError extends Error {
  readonly code: "daemon_build_stale" | "kernel_schema_mismatch";
  constructor(code: "daemon_build_stale" | "kernel_schema_mismatch", message: string) { super(message); this.name = "DaemonAdmissionError"; this.code = code; }
}

export function makeDaemonRuntimeAdmissionGuard(options: { readonly runtimeFile?: string; readonly nowMs?: () => number; readonly schemaRecheckMs?: number } = {}): DaemonRuntimeAdmissionGuard {
  const build = options.runtimeFile ? runtimeBuildBaseline(options.runtimeFile) : processBuildBaseline, nowMs = options.nowMs ?? Date.now, recheckMs = options.schemaRecheckMs ?? schemaAdmissionRecheckMs;
  let schemaAdmittedAt = Number.NEGATIVE_INFINITY;
  return { assert: (rootDir, force = false) => { assertCurrentProcessBuild(build); const observedAt = nowMs(); if (!force && observedAt >= schemaAdmittedAt && observedAt - schemaAdmittedAt < recheckMs) return; assertProjectionSchema(rootDir); schemaAdmittedAt = observedAt; } };
}

function runtimeBuildBaseline(runtimeFile: string): RuntimeBuildBaseline | null {
  if (path.extname(runtimeFile) !== ".js") return null;
  const distRoot = path.resolve(path.dirname(runtimeFile), "../..");
  if (path.basename(distRoot) !== "dist") return null;
  const markerPath = path.join(distRoot, runtimeBuildIdFilename);
  return { markerPath, loadedBuildId: readBuildId(markerPath) };
}

function assertCurrentProcessBuild(baseline: RuntimeBuildBaseline | null): void {
  if (baseline === null) return;
  const currentBuildId = readBuildId(baseline.markerPath);
  if (baseline.loadedBuildId === null || currentBuildId !== baseline.loadedBuildId) throw new DaemonAdmissionError("daemon_build_stale", `daemon process loaded dist build ${baseline.loadedBuildId ?? "without a build id"}, but current dist build is ${currentBuildId ?? "missing"}; finish npm run build -w @harness-anything/cli, then stop and restart the resident daemon before retrying.`);
}

function assertProjectionSchema(rootDir: string): void {
  const projectionPath = defaultLifecycleTaskProjectionPath(rootDir), observed = readTaskProjectionSchemaVersion(projectionPath);
  if (observed !== null && observed !== taskProjectionSchemaVersion) throw new DaemonAdmissionError("kernel_schema_mismatch", `kernel projection schema ${observed} does not match daemon schema ${taskProjectionSchemaVersion}; stop the daemon, remove ${projectionPath}, then restart so the projection is rebuilt.`);
}

function readBuildId(markerPath: string): string | null {
  if (!existsSync(markerPath)) return null;
  const value = readFileSync(markerPath, "utf8").trim();
  return value || null;
}
