import { existsSync } from "node:fs";
import path from "node:path";
import { makeGitReadinessSource } from "./process-port.ts";

/**
 * dec_BB2BCE9F995CD3A126E2918734 CH4: every recorded Fact names the commit it was observed
 * against, resolved here by the daemon — the agent never supplies the value. A task in
 * execution has its managed worktree under this node's `.worktrees/<taskId>` and that
 * checkout's HEAD is the observation point; every other record is observed against the
 * canonical checkout's HEAD (the default-branch checkout this cell serves). A checkout that
 * cannot name a commit (a git-less workspace, or a freshly initialized one with an unborn
 * HEAD — the quickstart path) records without an anchor, exactly like every fact recorded
 * before this field existed; the anchor is observed metadata, never a write precondition.
 */
export function withObservedCommit<T extends Readonly<Record<string, unknown>>>(
  rootDir: string,
  action: T,
): T & { readonly observedCommit?: string } {
  if (typeof action.observedCommit === "string") return action as T & { readonly observedCommit?: string };
  const git = makeGitReadinessSource(),
    taskId = typeof action.taskId === "string" ? action.taskId.trim() : "",
    worktree = taskId ? path.join(rootDir, ".worktrees", taskId) : null;
  if (worktree !== null && existsSync(worktree)) {
    const head = git.run(worktree, ["rev-parse", "HEAD"]);
    if (head.ok) return { ...action, observedCommit: head.stdout };
  }
  const canonical = git.run(rootDir, ["rev-parse", "HEAD"]);
  return canonical.ok ? { ...action, observedCommit: canonical.stdout } : action;
}
