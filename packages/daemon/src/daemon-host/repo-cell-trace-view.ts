import { existsSync, lstatSync, opendirSync } from "node:fs";
import path from "node:path";
import type { WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import {
  GIT_COLLISION_FORMAT,
  GIT_HISTORY_FORMAT,
  MAX_TRACED_FILES,
  traceFileCausalHistory,
  type GitHistoryOutcome,
  type GitHistoryPort,
  type TraceWorktreeCollision,
} from "@harness-anything/application/internal/queries/file-trace-read.ts";
import type {
  QueryAction,
  QueryBinding,
  WorkQueryCell,
} from "@harness-anything/application/internal/queries/query-ports.ts";
import { runGitHistoryLog } from "./process-port.ts";

/** A valid repository whose HEAD has no commit yet has, truthfully, no history for any path. */
const UNBORN_HEAD =
  /does not have any commits yet|bad default revision 'HEAD'|unknown revision or path not in the working tree.*HEAD/iu;
const MAX_WORKTREE_ENTRIES = 32;
const MAX_WORKTREE_PROBES = 8;
const TASK_WORKTREE = /^task_[0-9a-f]{26}$/u;

/**
 * Host adapter for the application GitHistoryPort (dec_9979850C7CE87C17271D78E4D1 CH1/CH3): each
 * history read is one `git` child process through runGitHistoryLog, and each failure surfaces as
 * a structured `unavailable` outcome — a center cell without a source worktree is
 * `git_worktree_unavailable`, a failing git is `git_log_failed` with its exit status and stderr.
 */
export function makeWorkspaceGitHistoryPort(rootDir: string, historyOnly = false): GitHistoryPort {
  const readGit = (args: readonly string[]): GitHistoryOutcome => {
    if (!existsSync(path.join(rootDir, ".git")))
      return {
        availability: "unavailable",
        reason: "git_worktree_unavailable",
        message: "This repository cell holds no local Git source worktree.",
      };
    const result = runGitHistoryLog(rootDir, ["--literal-pathspecs", ...args]);
    if (result.ok) return { availability: "available", stdout: result.stdout };
    if (result.exitCode !== null && UNBORN_HEAD.test(result.stderr)) return { availability: "available", stdout: "" };
    return {
      availability: "unavailable",
      reason: "git_log_failed",
      message: `git ${args[0] ?? ""} failed (exit ${String(result.exitCode)}${
        result.errorCode === null ? "" : `, ${result.errorCode}`
      }): ${result.stderr || "no diagnostic output"}`,
    };
  };
  const history: GitHistoryPort = {
    readPathHistory: ({ paths, maxCommits }) =>
      readGit([
        "log",
        "-m",
        "--first-parent",
        "--name-only",
        `--max-count=${String(maxCommits)}`,
        `--format=${GIT_HISTORY_FORMAT}`,
        "--",
        ...paths.slice(0, MAX_TRACED_FILES),
      ]),
  };
  if (historyOnly) return history;
  return {
    ...history,
    readBranchCollisions: ({ paths, maxCommits }) =>
      readGit([
        "log",
        "--source",
        "--name-only",
        "-z",
        `--max-count=${String(maxCommits)}`,
        `--format=${GIT_COLLISION_FORMAT}`,
        "--branches=task_*",
        "--not",
        "HEAD",
        "--",
        ...paths.slice(0, MAX_TRACED_FILES),
      ]),
    readDirtyWorktreeCollisions: (input) => readDirtyWorktreeCollisions(rootDir, input),
  };
}

function readDirtyWorktreeCollisions(
  rootDir: string,
  { paths, excludeTaskId }: { readonly paths: readonly string[]; readonly excludeTaskId?: string },
): readonly TraceWorktreeCollision[] {
  const directory = path.join(rootDir, ".worktrees"),
    targets = paths.slice(0, MAX_TRACED_FILES),
    collisions: TraceWorktreeCollision[] = [];
  if (targets.length === 0 || !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return collisions;
  const entries = opendirSync(directory);
  try {
    let probes = 0;
    for (let visited = 0; visited < MAX_WORKTREE_ENTRIES && probes < MAX_WORKTREE_PROBES; visited++) {
      const entry = entries.readSync();
      if (entry === null) break;
      const taskId = entry.name;
      if (!entry.isDirectory() || !TASK_WORKTREE.test(taskId) || taskId === excludeTaskId) continue;
      const worktree = path.join(directory, taskId);
      if (!lstatSync(path.join(worktree, ".git"), { throwIfNoEntry: false })?.isFile()) continue;
      probes++;
      const status = runGitHistoryLog(worktree, [
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        "--untracked-files=all",
        "--ignore-submodules=all",
        "--",
        ...targets,
      ]);
      // A disappearing, inaccessible or slow peer worktree is advisory. Continue sampling the others.
      if (!status.ok) continue;
      const changed = status.stdout
          .split("\0")
          .filter(Boolean)
          .map((record) => record.slice(3)),
        tracePaths = targets.filter((target) =>
          changed.some((file) => file === target || file.startsWith(`${target}/`)),
        );
      if (tracePaths.length > 0) collisions.push({ taskId, tracePaths });
    }
  } finally {
    entries.closeSync();
  }
  return collisions;
}

/** `ha trace <path>`: the read receipt around the application trace, with the host Git port injected. */
export function traceView(cell: WorkQueryCell, action: QueryAction, binding: QueryBinding): WriteReceipt {
  const result = traceFileCausalHistory({
    projection: cell.projection,
    path: action.path,
    limit: action.limit,
    gitHistory: makeWorkspaceGitHistoryPort(cell.rootDir),
  });
  if (!result.ok) throw cell.cellCodedError(result.code, result.message);
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, result.projectionCut.sourceRevision),
    result,
    result.projectionCut.sourceRevision,
    null,
    result.projectionCut,
  );
}
