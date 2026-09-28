import { existsSync } from "node:fs";
import path from "node:path";
import type { TaskV2 } from "@harness-anything/kernel";
import { readDispatchStream, readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runProcessText } from "./process-port.ts";
import { runtimePidIsAlive } from "./runtime-process-liveness.ts";
import { taskWorktreeBinding, type PresetSnapshotRead } from "./task-worktree.ts";

// dec_8B3FCCD256CAC5B0BF3CCEDE58 CH1: task worktrees checked out before the rename carry the old name, directory
// .worktrees/<slug>-<id8> on branch codex/<slug>-<id8>. `ha task contract migrate` renames each one to the task id
// once; nothing at run time knows the old name. This file goes away once no node holds an old-name worktree.

export type LegacyWorktreeRow =
  | { readonly taskId: string; readonly status: "worktree-rename" | "worktree-renamed"; readonly from: string }
  | { readonly taskId: string; readonly status: "manual"; readonly reason: string; readonly worktree: string };

/** Old-name worktrees of the given tasks: renamed on apply, listed on a dry run, left alone when not safe to move. */
export function renameLegacyTaskWorktrees(
  rootDir: string,
  tasks: readonly (TaskV2 | null | undefined)[],
  readPresetSnapshot: PresetSnapshotRead,
  apply: boolean,
): readonly LegacyWorktreeRow[] {
  const rows: LegacyWorktreeRow[] = [];
  for (const task of tasks) {
    const binding = taskWorktreeBinding(task, readPresetSnapshot),
      slug = task?.metadata?.slug;
    if (!task || !binding || !slug) continue;
    const legacy = `${slug}-${task.taskId
        .replace(/^task[-_]/u, "")
        .replace(/[^A-Za-z0-9]/gu, "")
        .slice(0, 8)}`,
      from = path.join(rootDir, ".worktrees", legacy),
      to = path.join(rootDir, binding.path);
    if (!existsSync(from)) continue;
    const blocked = (reason: string): LegacyWorktreeRow => ({
      taskId: task.taskId,
      status: "manual",
      reason,
      worktree: from,
    });
    if (existsSync(to)) rows.push(blocked("worktree_target_exists"));
    else if (git(from, "branch", "--show-current") !== `codex/${legacy}`)
      rows.push(blocked("worktree_branch_unexpected"));
    else if (git(from, "status", "--porcelain")) rows.push(blocked("worktree_uncommitted_changes"));
    else if (liveDispatchIn(rootDir, from)) rows.push(blocked("worktree_in_use_by_live_dispatch"));
    else if (!apply) rows.push({ taskId: task.taskId, status: "worktree-rename", from });
    else {
      git(rootDir, "worktree", "move", from, to);
      git(to, "branch", "-m", binding.branch);
      rows.push({ taskId: task.taskId, status: "worktree-renamed", from });
    }
  }
  return rows;
}

/** A dispatch whose process still runs with its cwd inside the worktree; moving it would pull the floor out. */
function liveDispatchIn(rootDir: string, worktree: string): boolean {
  for (const header of readDispatchStreamHeaders(rootDir)) {
    if (!header.cwd) continue;
    const relative = path.relative(worktree, header.cwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const worker = readDispatchStream(rootDir, header.dispatchId)?.process;
    if (worker && !worker.exited && runtimePidIsAlive(worker.pid)) return true;
  }
  return false;
}

function git(cwd: string, ...args: string[]): string {
  return runProcessText("git", ["-C", cwd, ...args]).trim();
}
