import { existsSync } from "node:fs";
import path from "node:path";
import type { WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import {
  GIT_COLLISION_FORMAT,
  GIT_HISTORY_FORMAT,
  MAX_TRACED_FILES,
  traceFileCausalHistory,
  type GitHistoryOutcome,
  type GitHistoryPort,
} from "@harness-anything/application/internal/queries/file-trace-read.ts";
import type { QueryAction, QueryBinding, WorkQueryCell } from "@harness-anything/application/internal/queries/query-ports.ts";
import { runGitHistoryLog } from "./process-port.ts";

/** A valid repository whose HEAD has no commit yet has, truthfully, no history for any path. */
const UNBORN_HEAD = /does not have any commits yet|bad default revision 'HEAD'|unknown revision or path not in the working tree.*HEAD/iu;

/**
 * Host adapter for the application GitHistoryPort (dec_9979850C7CE87C17271D78E4D1 CH1/CH3): every
 * method is exactly one `git` child process through runGitHistoryLog, and every failure surfaces as
 * a structured `unavailable` outcome — a center cell without a source worktree is
 * `git_worktree_unavailable`, a failing git is `git_log_failed` with its exit status and stderr.
 */
export function makeWorkspaceGitHistoryPort(rootDir: string): GitHistoryPort {
  const run = (args: readonly string[]): GitHistoryOutcome => {
    if (!existsSync(path.join(rootDir, ".git")))
      return {
        availability: "unavailable",
        reason: "git_worktree_unavailable",
        message: "This repository cell holds no local Git source worktree.",
      };
    const result = runGitHistoryLog(rootDir, args);
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
  return {
    readPathHistory: ({ paths, maxCommits }) =>
      run([
        "log",
        "-m",
        "--first-parent",
        "--name-only",
        `--max-count=${String(maxCommits)}`,
        `--format=${GIT_HISTORY_FORMAT}`,
        "--",
        ...paths.slice(0, MAX_TRACED_FILES),
      ]),
    readBranchCollisions: ({ path: tracePath, maxCommits }) =>
      run([
        "log",
        "--source",
        `--max-count=${String(maxCommits)}`,
        `--format=${GIT_COLLISION_FORMAT}`,
        "--branches=task_*",
        "--not",
        "HEAD",
        "--",
        tracePath,
      ]),
  };
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
