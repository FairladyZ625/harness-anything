import path from "node:path";
import { isDomainStatus } from "@harness-anything/kernel";
import {
  fleetMirrorCutFile,
  locateFleetMirrorView,
  type FleetMirrorApplyResult,
  type FleetMirrorView,
} from "./fleet-edge-mirror.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { repositoryBaseRef, type WorktreeReclaim } from "./schedule-occurrence-workspace.ts";
import { reclaimClosedTaskWorktree, taskClosed, worktreeDirectories } from "./task-worktree.ts";

// dec_57370FF2021DADF04E3B21724D CH4: an edge never receives the write that closes a task, so the cut it has just
// mirrored is where it learns of one. After every applied cut the node reclaims its own checkouts of the tasks that
// cut says are closed, by the rule every managed worktree ends by. Nothing here reaches the center: each node holds
// and reclaims only its own directories, and a node that was offline catches up on its next sync.

/** What one applied cut made this node do with its task worktrees; a person reads it in the sync or command receipt. */
export interface EdgeTaskWorktreeReclaim {
  readonly removed: readonly { readonly taskId: string; readonly archiveTag: string | null }[];
  readonly retained: readonly { readonly taskId: string; readonly reason: string }[];
}

/** Call inside the mirror round that applied the cut. Null when the cut closed nothing this node holds. */
export async function reclaimEdgeTaskWorktrees(
  mirror: { readonly viewRoot: string; readonly repoId: string; readonly workspaceRoot: string },
  // A blocked pull has not converged with the center, so what it says about a task is not yet to act on.
  applied: Pick<FleetMirrorApplyResult, "outcome">,
): Promise<EdgeTaskWorktreeReclaim | null> {
  const held = applied.outcome === "applied" ? worktreeDirectories(mirror.workspaceRoot) : [],
    view = held.length > 0 ? locateFleetMirrorView(mirror.viewRoot, mirror.repoId) : null;
  // A Git-less edge has no worktree to reclaim.
  if (view === null || !repositoryBaseRef(mirror.workspaceRoot)) return null;
  const removed: { taskId: string; archiveTag: string | null }[] = [],
    retained: { taskId: string; reason: string }[] = [];
  for (const taskId of held) {
    if (!mirroredTaskClosed(view, taskId)) continue;
    // A reclaim that fails never fails the round that mirrored the cut: the checkout stays and says why.
    const result = await reclaimEdgeTaskWorktree(mirror.workspaceRoot, taskId).catch(
      (error: unknown): WorktreeReclaim => ({
        outcome: "retained",
        reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    if (result.outcome === "removed") removed.push({ taskId, archiveTag: result.archiveTag });
    else if (result.outcome === "retained") retained.push({ taskId, reason: result.reason });
  }
  return removed.length + retained.length > 0 ? { removed, retained } : null;
}

async function reclaimEdgeTaskWorktree(workspaceRoot: string, taskId: string): Promise<WorktreeReclaim> {
  const binding = { branch: taskId, path: path.join(".worktrees", taskId) },
    cwd = path.join(workspaceRoot, binding.path);
  // A task checkout is on the branch named after its task; any other directory here is not Harness's to end.
  if ((await git(cwd, "branch", "--show-current")) !== binding.branch) return { outcome: "absent" };
  // Commits no remote has exist on this node alone, where nobody would look for an archive tag: the checkout stays.
  const unpublished = Number(await git(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes"));
  if (unpublished > 0)
    return { outcome: "retained", reason: `${unpublished} commit${unpublished === 1 ? "" : "s"} no remote has` };
  return (await reclaimClosedTaskWorktree(workspaceRoot, taskId, binding))?.result ?? { outcome: "absent" };
}

/**
 * Whether the mirrored cut says this task is closed, read from the INDEX.md of the package that declares it. A name
 * no mirrored package declares is not a task this node knows — a schedule occurrence's worktree, a person's own —
 * and is left alone: task packages are tombstoned, never removed from the ledger.
 */
function mirroredTaskClosed(view: FleetMirrorView, taskId: string): boolean {
  const declared = [...view.entries.keys()]
    .filter((logical) => {
      const folder = /^tasks\/([^/]+)\/INDEX\.md$/u.exec(logical)?.[1];
      return folder === taskId || folder?.startsWith(`${taskId}-`);
    })
    .map((logical) => frontmatter(fleetMirrorCutFile(view, logical)?.toString("utf8") ?? ""))
    .filter((index) => index.some((line) => line === `task_id: ${taskId}` || line === `taskId: ${taskId}`));
  return (
    declared.length > 0 &&
    declared.every((index) => {
      const field = (pattern: RegExp) => index.map((line) => pattern.exec(line)?.[1]).find(Boolean),
        status = field(/^ {0,2}status: (\S+)$/u) ?? "";
      return (
        isDomainStatus(status) && taskClosed({ status, packageDisposition: field(/^packageDisposition: (\S+)$/u) })
      );
    })
  );
}

/** The lines of a document's leading `---` block: the machine-written fields, never its prose. */
function frontmatter(document: string): readonly string[] {
  const lines = document.split(/\r?\n/u);
  return lines[0] === "---" ? lines.slice(1, Math.max(1, lines.indexOf("---", 1))) : [];
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return runProcessTextAsync("git", ["-C", cwd, ...args]).then((output) => output.trim());
}
