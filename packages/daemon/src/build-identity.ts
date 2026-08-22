import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumeKnownError } from "../../kernel/src/index.ts";
import { runProcessText } from "./process-port.ts";

export interface DaemonBuildStamp { readonly commit: string | null }
export interface DaemonBuildStatus extends DaemonBuildStamp { readonly loadedBuildId: string | null; readonly diskBuildId: string | null; readonly drifted: boolean }
export interface DaemonBuildObserver { readonly status: () => DaemonBuildStatus }
let stamp: DaemonBuildStamp | undefined;
const buildIdFilename = "build-id.txt", processMarkerPath = buildMarkerPath(fileURLToPath(import.meta.url)), processLoadedBuildId = processMarkerPath === null ? null : readBuildId(processMarkerPath);
// A resident daemon serves the code it was started from for its whole life, while the tree it came
// from keeps moving, so the daemon is the side that has to say which build it is: a commit frozen
// here at first use. Packaged runs carry a build stamp; a source-tree run resolves it from git.
// Clients run the same function against their own tree, and a mismatch is the diagnosis, not an
// error to paper over — this repo keeps no cross-version compatibility.
export function daemonBuildStamp(): DaemonBuildStamp {
  stamp ??= resolveStamp();
  return stamp;
}
export function observeDaemonBuild(runtimeFile?: string): DaemonBuildObserver {
  const markerPath = runtimeFile === undefined ? processMarkerPath : buildMarkerPath(runtimeFile), loadedBuildId = runtimeFile === undefined ? processLoadedBuildId : markerPath === null ? null : readBuildId(markerPath);
  return { status: () => { const diskBuildId = markerPath === null ? null : readBuildId(markerPath); return { ...daemonBuildStamp(), loadedBuildId, diskBuildId, drifted: loadedBuildId !== diskBuildId }; } };
}
function resolveStamp(): DaemonBuildStamp {
  const stamped = process.env.HARNESS_BUILD_COMMIT?.trim();
  if (stamped) return { commit: stamped };
  try {
    const commit = runProcessText("git", ["rev-parse", "HEAD"], path.dirname(fileURLToPath(import.meta.url))).trim();
    return { commit: commit || null };
  } catch (error) { consumeKnownError(error); return { commit: null }; }
}
function buildMarkerPath(runtimeFile: string): string | null {
  if (path.extname(runtimeFile) !== ".js") return null;
  const distRoot = path.resolve(path.dirname(runtimeFile), "../..");
  return path.basename(distRoot) === "dist" ? path.join(distRoot, buildIdFilename) : null;
}
function readBuildId(markerPath: string): string | null {
  if (!existsSync(markerPath)) return null;
  const value = readFileSync(markerPath, "utf8").trim();
  return value || null;
}
