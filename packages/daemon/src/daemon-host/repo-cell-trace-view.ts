import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { TaskProjectionQueries, WriteReceiptDraft as WriteReceipt } from "@harness-anything/kernel";
import {
  DEFAULT_TRACE_COMMITS,
  extractReferencedCodePaths,
  GIT_COLLISION_FORMAT,
  GIT_HISTORY_FORMAT,
  MAX_TRACED_FILES,
  traceFileCausalHistory,
  type GitHistoryOutcome,
  type GitHistoryPort,
  type TraceWorktreeCollision,
  type TraceWorktreeCollisionScan,
} from "@harness-anything/application/internal/queries/file-trace-read.ts";
import type {
  QueryAction,
  QueryBinding,
  WorkQueryCell,
} from "@harness-anything/application/internal/queries/query-ports.ts";
import { readDispatchStream } from "./dispatch-stream.ts";
import { withLocalWorktreeCollisions } from "./dispatch-causal-context.ts";
import {
  runGitHistoryLog,
  runGitHistoryLogAsync,
  type AsyncGitHistoryLogRunner,
  type GitHistoryLogResult,
} from "./process-port.ts";

/** A valid repository whose HEAD has no commit yet has, truthfully, no history for any path. */
const UNBORN_HEAD =
  /does not have any commits yet|bad default revision 'HEAD'|unknown revision or path not in the working tree.*HEAD/iu;
const MAX_WORKTREE_PROBES = 32;
const TASK_WORKTREE = /^task_[0-9a-f]{26}$/u;
const MISSING_WORKTREE_OUTCOME: GitHistoryOutcome = Object.freeze({
  availability: "unavailable",
  reason: "git_worktree_unavailable",
  message: "This repository cell holds no local Git source worktree.",
});
const SNAPSHOT_DRIFT_OUTCOME: GitHistoryOutcome = Object.freeze({
  availability: "unavailable",
  reason: "git_worktree_unavailable",
  message: "Pre-collected Git history snapshot does not match the current task plan paths.",
});
const EMPTY_WORKTREE_SCAN: TraceWorktreeCollisionScan = Object.freeze({
  collisions: [],
  scannedWorktrees: 0,
  notScannedWorktrees: 0,
  truncated: false,
});

function gitHistoryOutcomeFromResult(args: readonly string[], result: GitHistoryLogResult): GitHistoryOutcome {
  if (result.ok) return { availability: "available", stdout: result.stdout };
  if (result.exitCode !== null && UNBORN_HEAD.test(result.stderr)) return { availability: "available", stdout: "" };
  return {
    availability: "unavailable",
    reason: "git_log_failed",
    message: `git ${args[0] ?? ""} failed (exit ${String(result.exitCode)}${
      result.errorCode === null ? "" : `, ${result.errorCode}`
    }): ${result.stderr || "no diagnostic output"}`,
  };
}

function pathHistoryGitArgs(paths: readonly string[], maxCommits: number): readonly string[] {
  return [
    "log",
    "-m",
    "--first-parent",
    "--name-only",
    `--max-count=${String(maxCommits)}`,
    `--format=${GIT_HISTORY_FORMAT}`,
    "--",
    ...paths.slice(0, MAX_TRACED_FILES),
  ];
}

function branchCollisionGitArgs(paths: readonly string[], maxCommits: number): readonly string[] {
  return [
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
  ];
}

function dirtyWorktreeStatusGitArgs(targets: readonly string[]): readonly string[] {
  return [
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
  ];
}

function dirtyWorktreeTracePaths(stdout: string, targets: readonly string[]): readonly string[] {
  const changed = stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => record.slice(3));
  return targets.filter((target) => changed.some((file) => file === target || file.startsWith(`${target}/`)));
}

function sameTracePaths(expected: readonly string[], requested: readonly string[]): boolean {
  const bounded = requested.slice(0, MAX_TRACED_FILES);
  return expected.length === bounded.length && expected.every((entry, index) => entry === bounded[index]);
}

/**
 * Host adapter for the application GitHistoryPort (dec_9979850C7CE87C17271D78E4D1 CH1/CH3): each
 * history read is one `git` child process through runGitHistoryLog, and each failure surfaces as
 * a structured `unavailable` outcome — a center cell without a source worktree is
 * `git_worktree_unavailable`, a failing git is `git_log_failed` with its exit status and stderr.
 */
export function makeWorkspaceGitHistoryPort(rootDir: string, historyOnly = false): GitHistoryPort {
  const readGit = (args: readonly string[]): GitHistoryOutcome => {
    if (!existsSync(path.join(rootDir, ".git"))) return MISSING_WORKTREE_OUTCOME;
    return gitHistoryOutcomeFromResult(args, runGitHistoryLog(rootDir, ["--literal-pathspecs", ...args]));
  };
  const history: GitHistoryPort = {
    readPathHistory: ({ paths, maxCommits }) => readGit(pathHistoryGitArgs(paths, maxCommits)),
  };
  if (historyOnly) return history;
  return {
    ...history,
    readBranchCollisions: ({ paths, maxCommits }) => readGit(branchCollisionGitArgs(paths, maxCommits)),
    readDirtyWorktreeCollisions: (input) => readDirtyWorktreeCollisions(rootDir, input),
  };
}

/**
 * Pre-collects reverse-trace Git history and collision scans asynchronously outside the single-writer
 * slot (dec_9979850C7CE87C17271D78E4D1 CH1). The returned `GitHistoryPort` is pure in-memory and
 * spawns zero child processes when consumed inside `enqueueRuntimePublication`; if the task plan's
 * traced paths changed before publication, it returns structured `unavailable` instead of falling
 * back to Git inside the write slot.
 */
export async function prepareWorkspaceGitHistorySnapshot(input: {
  readonly rootDir: string;
  readonly paths: readonly string[];
  readonly excludeTaskId?: string;
  readonly historyMaxCommits?: number;
  readonly collisionMaxCommits?: number;
  readonly runGit?: AsyncGitHistoryLogRunner;
}): Promise<GitHistoryPort> {
  const snapshotPaths = input.paths.slice(0, MAX_TRACED_FILES),
    historyMaxCommits = input.historyMaxCommits ?? DEFAULT_TRACE_COMMITS * 2,
    collisionMaxCommits = input.collisionMaxCommits ?? DEFAULT_TRACE_COMMITS,
    runGit = input.runGit ?? runGitHistoryLogAsync;
  if (snapshotPaths.length === 0) {
    return {
      readPathHistory: ({ paths }) =>
        sameTracePaths(snapshotPaths, paths) ? { availability: "available", stdout: "" } : SNAPSHOT_DRIFT_OUTCOME,
      readBranchCollisions: ({ paths }) =>
        sameTracePaths(snapshotPaths, paths) ? { availability: "available", stdout: "" } : SNAPSHOT_DRIFT_OUTCOME,
      readDirtyWorktreeCollisions: () => EMPTY_WORKTREE_SCAN,
    };
  }
  const hasGit = existsSync(path.join(input.rootDir, ".git")),
    readGitAsync = async (args: readonly string[]): Promise<GitHistoryOutcome> => {
      if (!hasGit) return MISSING_WORKTREE_OUTCOME;
      return gitHistoryOutcomeFromResult(args, await runGit(input.rootDir, ["--literal-pathspecs", ...args]));
    },
    [pathHistory, branchCollisions, dirtyWorktreeScan] = await Promise.all([
      readGitAsync(pathHistoryGitArgs(snapshotPaths, historyMaxCommits)),
      readGitAsync(branchCollisionGitArgs(snapshotPaths, collisionMaxCommits)),
      readDirtyWorktreeCollisionsAsync(input.rootDir, snapshotPaths, input.excludeTaskId, runGit),
    ]);
  return {
    readPathHistory: ({ paths, maxCommits }) =>
      sameTracePaths(snapshotPaths, paths) && maxCommits <= historyMaxCommits ? pathHistory : SNAPSHOT_DRIFT_OUTCOME,
    readBranchCollisions: ({ paths, maxCommits }) =>
      sameTracePaths(snapshotPaths, paths) && maxCommits <= collisionMaxCommits
        ? branchCollisions
        : SNAPSHOT_DRIFT_OUTCOME,
    readDirtyWorktreeCollisions: ({ paths, excludeTaskId }) =>
      sameTracePaths(snapshotPaths, paths) && excludeTaskId === input.excludeTaskId
        ? dirtyWorktreeScan
        : EMPTY_WORKTREE_SCAN,
  };
}

/** Pre-queue host preparation for local task dispatches: reads plan paths and snapshots Git asynchronously. */
export async function prepareRuntimeCausalGitHistory(input: {
  readonly rootDir: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly projection?: () => TaskProjectionQueries;
  readonly remote?: unknown;
  readonly runGitHistoryAsync?: AsyncGitHistoryLogRunner;
}): Promise<GitHistoryPort | undefined> {
  if (input.remote !== undefined || input.projection === undefined) return undefined;
  const resumedStream =
      typeof input.payload.dispatchId === "string" ? readDispatchStream(input.rootDir, input.payload.dispatchId) : null,
    taskId = typeof input.payload.taskId === "string" ? input.payload.taskId : (resumedStream?.header.taskId ?? null);
  if (taskId === null) return undefined;
  const projection = input.projection(),
    self = projection.readTaskIndex({ taskIds: [taskId] }),
    packagePath = self.rows.find((row) => row.taskId === taskId)?.packagePath ?? null,
    plan = packagePath === null ? null : projection.readDocument(`${packagePath}/task_plan.md`).document,
    paths = plan === null ? [] : extractReferencedCodePaths(plan.body, MAX_TRACED_FILES);
  return prepareWorkspaceGitHistorySnapshot({
    rootDir: input.rootDir,
    paths,
    excludeTaskId: taskId,
    runGit: input.runGitHistoryAsync,
  });
}

function readDirtyWorktreeCollisions(
  rootDir: string,
  { paths, excludeTaskId }: { readonly paths: readonly string[]; readonly excludeTaskId?: string },
): TraceWorktreeCollisionScan {
  const directory = path.join(rootDir, ".worktrees"),
    targets = paths.slice(0, MAX_TRACED_FILES),
    collisions: TraceWorktreeCollision[] = [];
  if (targets.length === 0 || !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
    return { collisions, scannedWorktrees: 0, notScannedWorktrees: 0, truncated: false };
  const worktrees = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && TASK_WORKTREE.test(entry.name) && entry.name !== excludeTaskId)
      .flatMap((entry) => {
        const worktree = path.join(directory, entry.name);
        if (!lstatSync(path.join(worktree, ".git"), { throwIfNoEntry: false })?.isFile()) return [];
        return [{ taskId: entry.name, worktree, activityTime: statSync(worktree).mtimeMs }];
      })
      // Newly materialized or recently touched task worktrees are the most likely to be active.
      .toSorted((left, right) => right.activityTime - left.activityTime || left.taskId.localeCompare(right.taskId)),
    selected = worktrees.slice(0, MAX_WORKTREE_PROBES),
    args = dirtyWorktreeStatusGitArgs(targets);
  for (const { taskId, worktree } of selected) {
    const status = runGitHistoryLog(worktree, args);
    // A disappearing, inaccessible or slow peer worktree is advisory. Continue sampling the others.
    if (!status.ok) continue;
    const tracePaths = dirtyWorktreeTracePaths(status.stdout, targets);
    if (tracePaths.length > 0) collisions.push({ taskId, tracePaths });
  }
  return {
    collisions,
    scannedWorktrees: selected.length,
    notScannedWorktrees: worktrees.length - selected.length,
    truncated: worktrees.length > selected.length,
  };
}

async function readDirtyWorktreeCollisionsAsync(
  rootDir: string,
  targets: readonly string[],
  excludeTaskId: string | undefined,
  runGit: AsyncGitHistoryLogRunner,
): Promise<TraceWorktreeCollisionScan> {
  const directory = path.join(rootDir, ".worktrees"),
    collisions: TraceWorktreeCollision[] = [];
  if (targets.length === 0) return EMPTY_WORKTREE_SCAN;
  const directoryStat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!directoryStat?.isDirectory()) return EMPTY_WORKTREE_SCAN;
  const entries = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && TASK_WORKTREE.test(entry.name) && entry.name !== excludeTaskId,
    ),
    probed = await Promise.all(
      entries.map(async (entry) => {
        const worktree = path.join(directory, entry.name),
          gitPointer = await lstat(path.join(worktree, ".git")).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          });
        if (!gitPointer?.isFile()) return null;
        const info = await stat(worktree).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        return info === null ? null : { taskId: entry.name, worktree, activityTime: info.mtimeMs };
      }),
    ),
    worktrees = probed
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .toSorted((left, right) => right.activityTime - left.activityTime || left.taskId.localeCompare(right.taskId)),
    selected = worktrees.slice(0, MAX_WORKTREE_PROBES),
    args = dirtyWorktreeStatusGitArgs(targets),
    // Independent read-only probes: together, the scan costs its slowest probe rather than their sum.
    statuses = await Promise.all(selected.map(({ worktree }) => runGit(worktree, args)));
  for (const [index, { taskId }] of selected.entries()) {
    const status = statuses[index]!;
    if (!status.ok) continue;
    const tracePaths = dirtyWorktreeTracePaths(status.stdout, targets);
    if (tracePaths.length > 0) collisions.push({ taskId, tracePaths });
  }
  return {
    collisions,
    scannedWorktrees: selected.length,
    notScannedWorktrees: worktrees.length - selected.length,
    truncated: worktrees.length > selected.length,
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

/**
 * Edge-local dirty-worktree collision scan layered onto center-built causal context before execution launch. It
 * runs on the daemon's event loop during dispatch, so its probes are asynchronous child processes.
 */
export async function enrichCausalContextWithLocalWorktrees(
  causalContext: string | null,
  input: {
    readonly workspaceRoot: string;
    readonly plan: string;
    readonly taskId: string;
    readonly skip: boolean;
    readonly runGit?: AsyncGitHistoryLogRunner;
  },
): Promise<string | null> {
  if (input.skip) return causalContext;
  return withLocalWorktreeCollisions(
    causalContext,
    await readDirtyWorktreeCollisionsAsync(
      input.workspaceRoot,
      extractReferencedCodePaths(input.plan),
      input.taskId,
      input.runGit ?? runGitHistoryLogAsync,
    ),
  );
}
