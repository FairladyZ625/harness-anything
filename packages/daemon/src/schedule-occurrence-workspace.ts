import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSettingsFacet, resolveHarnessLayout, type ScheduleV1 } from "@harness-anything/kernel";
import { makeGitReadinessSource, runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";
import type { TrustedScheduleRuntime } from "./runtime-spawn-types.ts";
import {
  cleanupWorktreeSetup,
  isLinkedWorktree,
  runWorktreeSetup,
  type WorktreeSetupSettings,
  unlinkWorktreeLedger,
  worktreeSetupFailure,
} from "./worktree-setup.ts";
import { liveDispatchIn } from "./live-dispatch-worktree.ts";

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

// A fetch that stalls on an unreachable remote must not hold a start or a dispatch; one that fails means no copy.
const publishedBranchFetchTimeoutMs = 30_000;

/**
 * dec_57370FF2021DADF04E3B21724D CH3: the copy of a task branch another node pushed at settlement, fetched here.
 * Null when origin has none or cannot be reached.
 */
export async function publishedBranchRef(rootDir: string, branch: string): Promise<string | null> {
  const fetched = await runProcessExitAsync(
    "git",
    ["-C", rootDir, "fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    undefined,
    { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    undefined,
    undefined,
    { timeoutMs: publishedBranchFetchTimeoutMs },
  ).then(
    (result) => result.exitCode === 0,
    () => false,
  );
  return fetched ? `origin/${branch}` : null;
}

/**
 * A rebase or merge a runtime stopped in the middle of leaves the checkout on a conflict it will never finish. The
 * operation is aborted here, restoring the branch to the commits the runtime made before it started, so a retry
 * continues that work instead of failing on the residue. A dispatch still running in the checkout is not touched:
 * its operation is live work, not residue.
 */
export async function abortInterruptedWorktreeOperation(rootDir: string, cwd: string): Promise<void> {
  if (!isLinkedWorktree(cwd)) return;
  const operation = await interruptedGitOperation(cwd);
  if (operation && !liveDispatchIn(rootDir, cwd)) await git(cwd, operation, "--abort");
}

/** The operation git recorded in the checkout, if any: its state directory, not its localized status text. */
async function interruptedGitOperation(cwd: string): Promise<"rebase" | "merge" | null> {
  const [rebaseMerge, rebaseApply, mergeHead] = (
      await git(
        cwd,
        "rev-parse",
        "--git-path",
        "rebase-merge",
        "--git-path",
        "rebase-apply",
        "--git-path",
        "MERGE_HEAD",
      )
    ).split("\n"),
    present = (gitPath: string | undefined) => gitPath !== undefined && existsSync(path.resolve(cwd, gitPath));
  if (present(rebaseMerge) || present(rebaseApply)) return "rebase";
  return present(mergeHead) ? "merge" : null;
}

/**
 * Brings a checkout that is behind the published task branch up to it, so a node that takes the task over
 * continues what the previous node pushed. With no work of its own the checkout fast-forwards. A branch the
 * checkout rewrote after seeing the published tip — the tip is reachable from one of its reflog entries, the
 * judgment `git push --force-if-includes` makes — is the task's newer progress and is kept as it is. A
 * published commit that no entry here records was pushed elsewhere after this checkout last moved and is
 * refused: continuing would drop it. Uncommitted changes are left exactly as they are.
 */
export async function continuePublishedBranch(cwd: string, published: string): Promise<void> {
  if ((await git(cwd, "rev-list", "--count", `HEAD..${published}`)) === "0") return;
  const aheadCount = Number(await git(cwd, "rev-list", "--count", `${published}..HEAD`)),
    dirty = (await git(cwd, "status", "--porcelain")).length > 0;
  if (aheadCount === 0 && !dirty) {
    await git(cwd, "merge", "--quiet", "--ff-only", published);
    return;
  }
  if (await publishedTipSeenInReflog(cwd, published)) return;
  throw Object.assign(
    new Error(
      `Worktree ${cwd} is behind ${published} and holds ` +
        (aheadCount !== 0 ? `${aheadCount} commit(s) that branch lacks` : "uncommitted changes") +
        `; ${published} has commit(s) this checkout's reflog never saw, so they were published elsewhere; ` +
        `it was left untouched. ` +
        (dirty
          ? `Inspect it with: git -C ${cwd} status --short`
          : `Inspect both sides with: git -C ${cwd} log --oneline --left-right ${published}...HEAD`),
    ),
    { code: "task_worktree_diverged" },
  );
}

/**
 * Whether the published tip is reachable from an entry of this checkout's reflog: the checkout saw that version
 * and rewrote it. git-push(1) defines the same judgment for `--force-if-includes`; a commit another node pushed
 * after the checkout last moved is in no entry.
 */
async function publishedTipSeenInReflog(cwd: string, published: string): Promise<boolean> {
  // `--force-if-includes` judges the reflog of the branch being pushed. A detached checkout — an operation still
  // in progress here — has no branch that rewrote a published tip, so it stays refused.
  const ref = await gitOrNull(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (!ref) return false;
  const entries = (await git(cwd, "rev-list", "--walk-reflogs", ref)).split("\n").filter(Boolean);
  if (entries.length === 0) return false;
  // Rev-list prints the published tip and its ancestors only when no reflog entry reaches it.
  const unseen = await gitFromStdin(
    cwd,
    [published, ...entries.map((entry) => `^${entry}`)].join("\n"),
    "rev-list",
    "--stdin",
  );
  return unseen.length === 0;
}

/**
 * Advances a checkout that holds no work of its own to the repository's present default branch, so a dispatch that
 * reuses a worktree an earlier refused or cancelled one cut still starts from the current baseline. A checkout with
 * commits of its own or uncommitted changes — work nobody has taken over — is left exactly as it is, and the
 * dispatch continues on it: nothing here discards work.
 */
export async function advanceIdleCheckout(cwd: string, ref: string): Promise<void> {
  if ((await git(cwd, "rev-list", "--count", `HEAD..${ref}`)) === "0") return;
  const ahead = await git(cwd, "rev-list", "--count", `${ref}..HEAD`),
    dirty = (await git(cwd, "status", "--porcelain")).length > 0;
  if (ahead !== "0" || dirty) return;
  await git(cwd, "merge", "--quiet", "--ff-only", ref);
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
 * Whether this directory is inside a Git work tree at all. An initialized repository with an unborn branch is
 * one (its HEAD names a branch but no commit); a Git-less edge is not, and dec_BBA713052997C3EF5F5D3DD952 CH3
 * records no workspace there instead of failing.
 */
export function hasGitWorkTree(rootDir: string): boolean {
  return gitOrNull(rootDir, "rev-parse", "--is-inside-work-tree") === "true";
}

/**
 * Whether HEAD names a branch that has no commit yet. That is the one repository state in which a worktree
 * binding cannot be cut from a base ref: an initialized repository whose default branch is still unborn. A
 * Git-less edge is not this state (it has no work tree), and a repository with a commit is not either even
 * when no default-branch candidate resolves.
 */
export function hasUnbornHead(rootDir: string): boolean {
  return hasGitWorkTree(rootDir) && !gitOrNull(rootDir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}");
}

/**
 * An explicit delivery.targetRef is the repository's work baseline, regardless of origin's history. An unavailable
 * declaration fails rather than choosing a different history. Without one, dec_8B3FCCD256CAC5B0BF3CCEDE58 CH2 uses
 * the repository's default branch: its published copy, else the main checkout's branch. Null when none resolves.
 */
export function repositoryBaseRef(rootDir: string): string | null {
  // Task checkouts mirror only their task package, so read the declaration from the primary worktree.
  const primary = gitOrNull(rootDir, "worktree", "list", "--porcelain", "-z")
    ?.split("\0")[0]
    ?.slice("worktree ".length);
  if (!primary) return null;
  const { configPath } = resolveHarnessLayout(primary),
    targetRef = configPath && readSettingsFacet(readFileSync(configPath, "utf8")).delivery.targetRef;
  if (targetRef) {
    if (!gitOrNull(rootDir, "rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`))
      throw new Error(`Configured delivery.targetRef ${targetRef} does not resolve to a commit in ${rootDir}.`);
    return targetRef;
  }
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
 * merges all count as upstream) first stay reachable from an archive/wt-<name> tag. A worktree that initialized
 * submodules is removed with `--force` only after that clean check: git refuses a plain removal of any worktree
 * holding submodules, and the check has already established there is no uncommitted work to lose.
 */
export async function reclaimManagedWorktree(rootDir: string, worktree: ManagedWorktree): Promise<WorktreeReclaim> {
  if (!existsSync(worktree.cwd)) return { outcome: "absent" };
  try {
    // What the setup adapters made is theirs to remove, not the work in the worktree.
    await cleanupWorktreeSetup(worktree.cwd);
    unlinkWorktreeLedger(rootDir, worktree.cwd);
    // `--ignore-submodules=none` makes a dirty submodule visible here whatever the repository config prefers.
    if ((await git(worktree.cwd, "status", "--porcelain", "--ignore-submodules=none")).length > 0)
      return { outcome: "retained", reason: "uncommitted changes" };
    const unmergedCommits = (await git(worktree.cwd, "cherry", worktree.baseRef, "HEAD"))
        .split("\n")
        .filter((line) => line.startsWith("+")).length,
      archiveTag = unmergedCommits > 0 ? `archive/wt-${path.basename(worktree.cwd)}` : null;
    if (archiveTag) await git(worktree.cwd, "tag", archiveTag, "HEAD");
    await git(
      rootDir,
      "worktree",
      "remove",
      ...((await hasInitializedSubmodules(worktree.cwd)) ? ["--force"] : []),
      worktree.cwd,
    );
    await git(rootDir, "branch", "-D", worktree.branch);
    return { outcome: "removed", archiveTag, unmergedCommits };
  } catch (error) {
    return { outcome: "retained", reason: `cleanup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Whether this worktree initialized any submodule checkout. `git worktree remove` refuses such a worktree even when it
 * is clean; one whose submodules were never initialized is removed normally.
 */
async function hasInitializedSubmodules(cwd: string): Promise<boolean> {
  return (await git(cwd, "submodule", "status", "--recursive"))
    .split("\n")
    .some((line) => line.length > 0 && !line.startsWith("-"));
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
  readWorktree: () => WorktreeSetupSettings,
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
  const worktree = readWorktree(),
    prepared = await runWorktreeSetup({
      rootDir,
      cwd,
      taskId: null,
      steps: worktree.setup,
      stepTimeoutMs: worktree.setupStepTimeoutMs,
    });
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

/** `git` with revisions on stdin, for a list that does not fit one argv. */
function gitFromStdin(cwd: string, input: string, ...args: string[]): Promise<string> {
  return runProcessTextAsync("git", ["-C", cwd, ...args], undefined, undefined, input).then((output) => output.trim());
}

function gitOrNull(cwd: string, ...args: string[]): string | null {
  const result = gitReadiness.run(cwd, args);
  return result.ok && result.stdout ? result.stdout : null;
}
