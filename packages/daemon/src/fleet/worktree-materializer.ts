import {
  applyFleetMirrorCut,
  cacheFleetMirrorDirtyBases,
  scanFleetMirrorWorktree,
  type FleetMirrorApplyResult,
  type FleetMirrorScan,
} from "../fleet-edge-mirror.ts";

/** Materializes the writable worktree from the currently published read generation.
 * Canonical writes remain owned by the center; this module only scans and stages local candidates. */
export function scanWorktreeMaterialization(input: {
  readonly viewRoot: string;
  readonly repoId: string;
  readonly workspaceRoot: string;
}): FleetMirrorScan {
  const view = locateFleetMirrorView(input.viewRoot, input.repoId);
  if (!view) throw new Error("replica view is unavailable");
  cacheFleetMirrorDirtyBases(input.viewRoot, input.repoId, input.workspaceRoot);
  return scanFleetMirrorWorktree(view, input.workspaceRoot);
}

export function publishWorktreeMaterialization(input: {
  readonly viewRoot: string;
  readonly repoId: string;
  readonly workspaceRoot: string;
  readonly trigger?: "pull" | "push-rejected" | "command-rejected";
}): FleetMirrorApplyResult {
  return applyFleetMirrorCut(input.viewRoot, input.repoId, input.workspaceRoot, input.trigger ?? "pull", {
    kind: "shared-docs",
  });
}
