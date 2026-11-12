import path from "node:path";
import type { DispatchLifecycleView } from "@harness-anything/kernel";

/** Workspace ownership outlives a stopped attempt while its group awaits a successor or ruling. */
export function liveDispatchIn(views: readonly DispatchLifecycleView[], worktree: string): boolean {
  return views.some(({ attempt, policy }) => {
    if (!policy.ownsWorkspace || !attempt.workspaceRef) return false;
    const relative = path.relative(worktree, attempt.workspaceRef);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}
