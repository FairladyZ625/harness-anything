import { existsSync } from "node:fs";
import path from "node:path";
import type { ScheduleV1 } from "@harness-anything/kernel";
import { makeGitReadinessSource, runProcessTextAsync } from "./process-port.ts";
import type { TrustedScheduleRuntime } from "./runtime-spawn-types.ts";
import {
  cleanupWorktreeSetup,
  runWorktreeSetup,
  unlinkWorktreeLedger,
  worktreeSetupFailure,
} from "./worktree-setup.ts";

/**
 * A git worktree Harness creates and reclaims itself — schedule occurrences, task checkouts and squad
 * workers all go through these two functions, so every managed worktree ends by the same rule.
 */
export interface ManagedWorktree {
  readonly cwd: string;
  readonly branch: string;
  /** Where a new branch starts, and what "already upstream" is judged against at reclaim. */
  readonly baseRef: string;
}

export type WorktreeReclaim =
  | { readonly outcome: "absent" }
  | { readonly outcome: "removed"; readonly archiveTag: string | null; readonly unmergedCommits: number }
  | { readonly outcome: "retained"; readonly reason: string };

export interface ScheduleOccurrenceWorkspace {
  readonly rootDir: string;
  readonly cwd: string;
  readonly runtime: TrustedScheduleRuntime;
}

/** Checks the worktree out, onto its existing branch when one survived a removed checkout. */
export async function addManagedWorktree(rootDir: string, worktree: ManagedWorktree): Promise<void> {
  const branchExists = await git(rootDir, "branch", "--list", worktree.branch);
  await git(
    rootDir,
    "worktree",
    "add",
    worktree.cwd,
    ...(branchExists ? [worktree.branch] : ["-b", worktree.branch, worktree.baseRef]),
  );
}

/**
 * The published copy of the repository's default branch: the one origin/HEAD names, else the origin copy of the
 * branch the main checkout has out. Null when neither resolves — an unfetched clone, a local-only repository. What
 * "published" and "merged" mean is judged against this ref, never against a literal branch name.
 */
export function remoteDefaultBranch(rootDir: string): string | null {
  return firstCommitRef(rootDir, defaultBranchCandidates(rootDir).slice(0, 2));
}

/**
 * dec_8B3FCCD256CAC5B0BF3CCEDE58 CH2: a new worktree starts from the repository's own default branch — its published
 * copy, else the branch the main checkout has out. Null when none of them resolves: a Git-less edge or a repository
 * before its first commit has no worktree to give.
 */
export function repositoryBaseRef(rootDir: string): string | null {
  return firstCommitRef(rootDir, defaultBranchCandidates(rootDir));
}

function defaultBranchCandidates(rootDir: string): readonly (string | null)[] {
  // HEAD of the common git directory is the main checkout's, also when rootDir is a linked worktree.
  const common = gitOrNull(rootDir, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    checkedOut = common && gitOrNull(rootDir, `--git-dir=${common}`, "symbolic-ref", "--quiet", "--short", "HEAD");
  return [
    gitOrNull(rootDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
    checkedOut && `origin/${checkedOut}`,
    checkedOut,
  ];
}

function firstCommitRef(rootDir: string, candidates: readonly (string | null)[]): string | null {
  return (
    candidates.find((ref) => ref && gitOrNull(rootDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) ?? null
  );
}

/**
 * dec_BBA713052997C3EF5F5D3DD952 CH2: uncommitted changes keep the worktree; otherwise it is removed with its
 * branch, and commits whose patches are not upstream yet (`git cherry` "+", so merge, rebase and squash
 * merges all count as upstream) first stay reachable from an archive/wt-<name> tag. Nothing is forced.
 */
export async function reclaimManagedWorktree(rootDir: string, worktree: ManagedWorktree): Promise<WorktreeReclaim> {
  if (!existsSync(worktree.cwd)) return { outcome: "absent" };
  try {
    // What the setup adapters made is theirs to remove, not the work in the worktree.
    await cleanupWorktreeSetup(worktree.cwd);
    unlinkWorktreeLedger(rootDir, worktree.cwd);
    if ((await git(worktree.cwd, "status", "--porcelain")).length > 0)
      return { outcome: "retained", reason: "uncommitted changes" };
    const unmergedCommits = (await git(worktree.cwd, "cherry", worktree.baseRef, "HEAD"))
        .split("\n")
        .filter((line) => line.startsWith("+")).length,
      archiveTag = unmergedCommits > 0 ? `archive/wt-${path.basename(worktree.cwd)}` : null;
    if (archiveTag) await git(worktree.cwd, "tag", archiveTag, "HEAD");
    await git(rootDir, "worktree", "remove", worktree.cwd);
    await git(rootDir, "branch", "-D", worktree.branch);
    return { outcome: "removed", archiveTag, unmergedCommits };
  } catch (error) {
    return { outcome: "retained", reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** What a reclaim left for a person to know about; a plain removal says nothing. */
export function reclaimDetail(label: string, worktree: ManagedWorktree, result: WorktreeReclaim): string | null {
  if (result.outcome === "retained") return `${label} retained at ${worktree.cwd} (${result.reason}).`;
  if (result.outcome === "removed" && result.archiveTag)
    return (
      `${label} ${worktree.cwd} removed; ${result.unmergedCommits} unmerged commit` +
      `${result.unmergedCommits === 1 ? "" : "s"} kept at tag ${result.archiveTag}.`
    );
  return null;
}

export async function prepareScheduleOccurrenceWorkspace(
  rootDir: string,
  schedule: ScheduleV1,
  /** Read only when a worktree is made: a detect occurrence runs in the root and prepares nothing. */
  readSetup: () => readonly string[],
): Promise<ScheduleOccurrenceWorkspace> {
  const active = schedule.status.activeRun;
  if (!active) throw new Error(`Schedule ${schedule.scheduleId} has no claimed occurrence workspace.`);
  const base = {
    scheduleId: schedule.scheduleId,
    occurrenceId: active.occurrenceId,
    claimFence: active.claimFence,
    mode: schedule.mode,
  } as const;
  if (schedule.mode === "detect") return { rootDir, cwd: rootDir, runtime: base };

  const branch = `occ-${active.occurrenceId}`,
    cwd = path.join(rootDir, ".worktrees", branch),
    baseRef = repositoryBaseRef(rootDir);
  if (!baseRef) throw new Error(`Repository ${rootDir} has no default branch to cut the occurrence worktree from.`);
  await addManagedWorktree(rootDir, { cwd, branch, baseRef });
  const prepared = await runWorktreeSetup({ rootDir, cwd, taskId: null, steps: readSetup() });
  if (!prepared.ok) throw new Error(worktreeSetupFailure(cwd, prepared, "let the next occurrence run"));
  return { rootDir, cwd, runtime: { ...base, worktree: { cwd, branch, baseRef } } };
}

export async function settleScheduleOccurrenceWorkspace(
  rootDir: string,
  schedule: TrustedScheduleRuntime,
): Promise<{ readonly detail: string | null }> {
  const worktree = schedule.worktree;
  if (!worktree) return { detail: null };
  return { detail: reclaimDetail("Occurrence worktree", worktree, await reclaimManagedWorktree(rootDir, worktree)) };
}

export async function scheduleSettlementDetail(
  rootDir: string,
  schedule: TrustedScheduleRuntime,
  detail: string | null,
): Promise<string | null> {
  const reclaimed = (await settleScheduleOccurrenceWorkspace(rootDir, schedule)).detail;
  return [detail, reclaimed].filter(Boolean).join(" ") || null;
}

const gitReadiness = makeGitReadinessSource();

function git(cwd: string, ...args: string[]): Promise<string> {
  return runProcessTextAsync("git", ["-C", cwd, ...args]).then((output) => output.trim());
}

function gitOrNull(cwd: string, ...args: string[]): string | null {
  const result = gitReadiness.run(cwd, args);
  return result.ok && result.stdout ? result.stdout : null;
}
