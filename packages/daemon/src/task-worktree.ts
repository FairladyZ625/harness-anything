import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  deriveTaskWorktreeBinding,
  isTerminalStatus,
  type TaskProjection,
  type TaskV2,
  type TaskWorktreeBindingV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
import { runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";
import type { TaskWorkspaceView } from "./protocol/daemon-protocol-gui-types.ts";
import {
  abortInterruptedWorktreeOperation,
  addManagedWorktree,
  advanceIdleCheckout,
  continuePublishedBranch,
  publishedBranchRef,
  reclaimDetail,
  reclaimManagedWorktree,
  remoteDefaultBranch,
  repositoryBaseRef,
  type ManagedWorktree,
  type WorktreeReclaim,
} from "./schedule-occurrence-workspace.ts";
import {
  isLinkedWorktree,
  runWorktreeSetup,
  worktreeSetupFailure,
  type WorktreeSetupResult,
  type WorktreeSetupSettings,
} from "./worktree-setup.ts";

// dec_BBA713052997C3EF5F5D3DD952: a task's worktree binding follows from fields fixed at its creation; the node
// that runs the task checks it out on first start or dispatch and reclaims it when the task closes. There is no
// worktree command. dec_8B3FCCD256CAC5B0BF3CCEDE58: it is cut from the repository's own default branch and
// prepared by the steps Settings `worktree.setup` declares.

const managedByHarness = "Harness manages this worktree; no command is needed.";

/** Reads a preset snapshot by digest: the task's profile output shape is one input of its binding. */
export type PresetSnapshotRead = (digest: string) => unknown;

/** One reader per request: tasks compiled from the same preset share one snapshot read. */
export function presetSnapshotReader(projection: Pick<TaskProjection, "readPresetSnapshot">): PresetSnapshotRead {
  const snapshots = new Map<string, unknown>();
  return (digest) => {
    if (!snapshots.has(digest)) snapshots.set(digest, projection.readPresetSnapshot(digest).snapshot);
    return snapshots.get(digest);
  };
}

/** The task's declared output shape: the compiled preset snapshot's profile field, or null before it compiles. */
export function taskOutputShape(
  task: { readonly presetSnapshotDigest?: string | null } | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): string | null {
  if (!task?.presetSnapshotDigest) return null;
  const snapshot = readPresetSnapshot(task.presetSnapshotDigest) as {
      readonly profile?: { readonly outputShape?: unknown };
    } | null,
    outputShape = snapshot?.profile?.outputShape;
  return typeof outputShape === "string" ? outputShape : null;
}

/** The binding is derived, never stored (dec_01KY4Y2MW94HM5QK5Q1208XJZ5): id, class and output shape. */
export function taskWorktreeBinding(
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): TaskWorktreeBindingV1 | null {
  const outputShape = taskOutputShape(task, readPresetSnapshot);
  return task && outputShape
    ? deriveTaskWorktreeBinding({ taskId: task.taskId, taskClass: task.taskClass, outputShape })
    : null;
}

/** What a node checks out for a task: its binding while the task is open, nothing once it is closed. */
export function openTaskWorktreeBinding(
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): TaskWorktreeBindingV1 | null {
  return task && !taskClosed(task) ? taskWorktreeBinding(task, readPresetSnapshot) : null;
}

/**
 * dec_8B3FCCD256CAC5B0BF3CCEDE58 CH4: every task has one place it works in — its worktree when it changes
 * repository files, otherwise its own task package directory.
 */
export function taskWorkspaceView(
  rootDir: string,
  task: TaskV2 | null | undefined,
  packagePath: string | null,
  readPresetSnapshot: PresetSnapshotRead,
  /** The authored root, resolved once by the caller; null where only a worktree is shown (the agenda reads no files). */
  authoredRoot: string | null,
): TaskWorkspaceView | null {
  const binding = taskWorktreeBinding(task, readPresetSnapshot);
  if (task && binding) {
    const present = isLinkedWorktree(path.join(rootDir, binding.path));
    return {
      kind: "worktree",
      ...binding,
      state: present ? (taskClosed(task) ? "retained" : "materialized") : taskClosed(task) ? "reclaimed" : "bound",
    };
  }
  if (!task || !packagePath || authoredRoot === null) return null;
  const packageRoot = path.join(authoredRoot, ...packagePath.split("/"));
  return { kind: "task-package", path: path.relative(rootDir, packageRoot).split(path.sep).join("/") };
}

export interface TaskWorktreeCheckout {
  readonly cwd: string;
  readonly branch: string;
  /**
   * What a new checkout was cut from: the task branch another node pushed, else the default branch; null when
   * the worktree was already here.
   */
  readonly baseRef: string | null;
  readonly setup: WorktreeSetupResult;
}

/**
 * Checks a binding out on this node, or finds it already there, then runs the Settings setup steps that have not
 * succeeded in it yet. The binding is all it takes: this node derives it from its projection, an edge receives it
 * from the center (dec_57370FF2021DADF04E3B21724D CH2). A checkout continues the delivery branch it holds — a new
 * one starts from the copy another node pushed before the default branch (CH3); with no pushed copy, an existing
 * one that never worked is advanced to the present default branch instead, so a checkout a refused or cancelled
 * dispatch left behind never pins its retry to a stale baseline. A node without a default branch (a Git-less edge,
 * a repository before its first commit) has no worktree to give: null, not a failure.
 * An accepted handoff commit instead requires that exact, retrievable SHA and a clean checkout before and after
 * setup. An existing checkout at another commit is preserved and refused.
 */
export interface TaskWorktreeCheckoutOptions {
  /**
   * The exact commit a reviewer must inspect. The checkout is created at this commit when absent, and an existing
   * checkout at any other commit is refused instead of being advanced: a review must never run on bytes other than
   * the frozen delivery it will register a verdict against. Absent for every non-reviewer caller.
   */
  readonly pinnedCommit?: string | null;
  /**
   * A reviewer whose cut has no code delivery has no commit to pin. It still reviews in the task worktree, but does
   * not sample or advance the published branch: the artifact submission is the subject, not the checkout tip.
   */
  readonly followPublishedBranch?: boolean;
}

export async function checkoutTaskWorktree(
  rootDir: string,
  taskId: string,
  binding: TaskWorktreeBindingV1,
  worktree: WorktreeSetupSettings,
  acceptedCommit?: string,
  stackedCommit?: string,
  options: TaskWorktreeCheckoutOptions = {},
): Promise<TaskWorktreeCheckout | null> {
  const cwd = path.join(rootDir, binding.path),
    steps = worktree.setup,
    stepTimeoutMs = worktree.setupStepTimeoutMs;
  return inWorktreeTurn(cwd, async () => {
    if (options.pinnedCommit !== undefined) {
      const pinnedCommit = options.pinnedCommit;
      if (pinnedCommit === null || !/^[0-9a-f]{40}$/u.test(pinnedCommit))
        throw cellCodedError(
          "review_checkout_commit_unavailable",
          `Task ${taskId}'s reviewer dispatch has no frozen delivery commit to check out.`,
        );
      const fresh = !existsSync(cwd);
      await ensurePinnedCommit(rootDir, binding.branch, pinnedCommit);
      if (fresh) await addPinnedReviewWorktree(rootDir, cwd, binding.branch, pinnedCommit);
      const verify = () => verifyReviewCheckout(cwd, pinnedCommit);
      await verify();
      const prepared = await runWorktreeSetup({ rootDir, cwd, taskId, steps, stepTimeoutMs, fresh });
      await verify();
      return {
        cwd,
        branch: fresh ? binding.branch : ((await heldBranch(cwd)) ?? binding.branch),
        baseRef: fresh ? pinnedCommit : null,
        setup: prepared,
      };
    }
    if (acceptedCommit !== undefined) {
      if (!/^[0-9a-f]{40}$/u.test(acceptedCommit))
        throw cellCodedError("runtime_handoff_sha_invalid", "Handoff requires a complete commit SHA.");
      const git = (directory: string, ...args: string[]) =>
        runProcessTextAsync(
          "git",
          ["-C", directory, ...args],
          undefined,
          { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          undefined,
          undefined,
          { timeoutMs: 30_000 },
        );
      // Fetch the immutable anchor, never a newer tip of the task branch.
      await git(rootDir, "fetch", "--quiet", "origin", acceptedCommit);
      const fresh = !existsSync(cwd);
      if (fresh) await addManagedWorktree(rootDir, { cwd, branch: binding.branch, baseRef: acceptedCommit });
      const verify = () => verifyHandoffWorktree(cwd, acceptedCommit);
      await verify();
      const prepared = await runWorktreeSetup({ rootDir, cwd, taskId, steps, stepTimeoutMs, fresh });
      await verify();
      return { cwd, branch: binding.branch, baseRef: fresh ? acceptedCommit : null, setup: prepared };
    }
    if (stackedCommit !== undefined) {
      if (!/^[0-9a-f]{40}$/u.test(stackedCommit))
        throw cellCodedError("invalid_proof", "Stack anchor requires a complete commit SHA.");
      const fresh = !existsSync(cwd);
      if (fresh) await addManagedWorktree(rootDir, { cwd, branch: binding.branch, baseRef: stackedCommit });
      const verify = async () => {
        const branch = await runProcessTextAsync("git", ["-C", cwd, "branch", "--show-current"]);
        if (branch.trim() !== binding.branch)
          throw cellCodedError("invalid_proof", "Stack checkout must use the task branch.");
        await runProcessTextAsync("git", ["-C", cwd, "merge-base", "--is-ancestor", stackedCommit, "HEAD"]);
      };
      await verify();
      const prepared = await runWorktreeSetup({ rootDir, cwd, taskId, steps, stepTimeoutMs, fresh });
      await verify();
      return { cwd, branch: binding.branch, baseRef: fresh ? stackedCommit : null, setup: prepared };
    }
    const fresh = !existsSync(cwd);
    if (fresh) await refreshDefaultBranch(rootDir);
    const defaultRef = repositoryBaseRef(rootDir);
    if (fresh && !defaultRef) return null;
    // A runtime that stopped mid-rebase or mid-merge leaves conflict residue; clear it before judging the branch.
    if (!fresh) await abortInterruptedWorktreeOperation(rootDir, cwd);
    // The delivery branch is the one the checkout holds; the task id only names the branch a fresh checkout is cut
    // as. A worker may move a task to another delivery branch, and judging it against origin/<task id> then measures
    // the abandoned branch.
    const branch = fresh ? binding.branch : ((await heldBranch(cwd)) ?? binding.branch),
      followPublished = options.followPublishedBranch !== false,
      // An artifact-only reviewer has no frozen code commit; it must not turn a publication state into its subject.
      published = followPublished || fresh ? await publishedBranchRef(rootDir, branch) : null;
    if (fresh) await addManagedWorktree(rootDir, { cwd, branch, baseRef: published ?? defaultRef! });
    if (followPublished) {
      // A checkout this node already had, or a branch that survived one, may predate another node's push.
      if (published) await continuePublishedBranch(cwd, published);
      // With no published task branch to continue, a checkout a refused or cancelled dispatch cut may also predate
      // the default branch itself: one that never worked is advanced, so the retry starts on the present baseline.
      else if (defaultRef) await advanceIdleCheckout(cwd, defaultRef);
    }
    return {
      cwd,
      branch,
      baseRef: fresh ? (published ?? defaultRef) : null,
      setup: await runWorktreeSetup({ rootDir, cwd, taskId, steps, stepTimeoutMs, fresh }),
    };
  });
}

/**
 * The branch a checkout delivers on; null on a detached HEAD, where the binding's branch still names the delivery.
 * A worker may switch a task to another delivery branch (a slice under a new name), so the checkout is the only
 * place that records which branch is now the task's.
 */
async function heldBranch(cwd: string): Promise<string | null> {
  const branch = (await runProcessTextAsync("git", ["-C", cwd, "branch", "--show-current"])).trim();
  return branch || null;
}

/** A reviewer's cut must be readable here: its own commit, the published task branch, or nothing to review. */
async function ensurePinnedCommit(rootDir: string, branch: string, commit: string): Promise<void> {
  const hasCommit = async () =>
    (
      await runProcessExitAsync(
        "git",
        ["-C", rootDir, "cat-file", "-e", `${commit}^{commit}`],
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: 30_000 },
      )
    ).exitCode === 0;
  if (await hasCommit()) return;
  // The cut may already be published on the task branch, including when this node never fetched it.
  for (const ref of [commit, `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    await runProcessExitAsync(
      "git",
      ["-C", rootDir, "fetch", "--quiet", "origin", ref],
      undefined,
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      undefined,
      undefined,
      { timeoutMs: 30_000 },
    ).then(
      () => undefined,
      () => undefined,
    );
  if (await hasCommit()) return;
  throw cellCodedError(
    "review_checkout_commit_unavailable",
    `The frozen delivery commit ${commit} is not available in ${rootDir}. Push the frozen cut or dispatch the review ` +
      "on a node that holds it; a reviewer must not inspect another commit.",
  );
}

/**
 * Creates a fresh reviewer checkout at the frozen commit. `addManagedWorktree` reuses a surviving
 * branch and ignores its baseRef, which would check out the stale cut this review must not read;
 * here a diverged branch is preserved under its own name before the task branch is created at the
 * frozen commit. A branch that is an ancestor of the frozen commit is simply advanced.
 */
async function addPinnedReviewWorktree(rootDir: string, cwd: string, branch: string, commit: string): Promise<void> {
  // Renaming or force-updating a branch that another worktree has checked out rewrites that
  // worktree's symbolic HEAD and breaks its delivery path. Preserve the other checkout instead.
  const otherOwner = (await branchWorktrees(rootDir, branch)).find(
    (owner) => path.resolve(owner) !== path.resolve(cwd),
  );
  if (otherOwner !== undefined)
    throw cellCodedError(
      "review_checkout_branch_in_use",
      `A reviewer checkout cannot use branch ${branch}: it is checked out at ${otherOwner}. ` +
        "Leave that worktree untouched; dispatch the review on a node without that branch, or remove the old checkout first.",
    );
  const branchTip = await refTip(rootDir, `refs/heads/${branch}`);
  if (branchTip === null) {
    await reviewGit(rootDir, "worktree", "add", cwd, "-b", branch, commit);
    return;
  }
  if (branchTip === commit) {
    await reviewGit(rootDir, "worktree", "add", cwd, branch);
    return;
  }
  const ancestor = await runProcessExitAsync(
    "git",
    ["-C", rootDir, "merge-base", "--is-ancestor", branchTip, commit],
    undefined,
    { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    undefined,
    undefined,
    { timeoutMs: 30_000 },
  );
  if (ancestor.exitCode === 0) {
    await reviewGit(rootDir, "branch", "-f", branch, commit);
    await reviewGit(rootDir, "worktree", "add", cwd, branch);
    return;
  }
  const preserved = `${branch}-superseded-${branchTip.slice(0, 12)}`;
  try {
    await reviewGit(rootDir, "branch", "-m", branch, preserved);
  } catch (error) {
    throw cellCodedError(
      "review_checkout_branch_in_use",
      `A reviewer checkout cannot move branch ${branch} aside to the frozen commit: ${errorText(error)}`,
    );
  }
  await reviewGit(rootDir, "worktree", "add", cwd, "-b", branch, commit);
}

/** Every worktree currently checking out this branch; a linked worktree's symbolic HEAD names it too. */
async function branchWorktrees(rootDir: string, branch: string): Promise<readonly string[]> {
  return (await reviewGit(rootDir, "worktree", "list", "--porcelain")).split("\n\n").flatMap((entry) => {
    const lines = entry.split("\n"),
      worktree = lines.find((line) => line.startsWith("worktree ")),
      ref = lines.find((line) => line.startsWith("branch "));
    return worktree !== undefined && ref === `branch refs/heads/${branch}` ? [worktree.slice("worktree ".length)] : [];
  });
}

async function refTip(rootDir: string, ref: string): Promise<string | null> {
  const result = await runProcessExitAsync(
    "git",
    ["-C", rootDir, "rev-parse", "--verify", "--quiet", ref],
    undefined,
    undefined,
    undefined,
    undefined,
    { timeoutMs: 30_000 },
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function reviewGit(rootDir: string, ...args: string[]): Promise<string> {
  return runProcessTextAsync(
    "git",
    ["-C", rootDir, ...args],
    undefined,
    { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    undefined,
    undefined,
    { timeoutMs: 30_000 },
  ).then((output) => output.trim());
}

/** The reviewer's checkout is the frozen cut or it is not prepared: never advance, reset, or silently accept another HEAD. */
async function verifyReviewCheckout(cwd: string, commit: string): Promise<void> {
  const head = (
    await runProcessTextAsync(
      "git",
      ["-C", cwd, "rev-parse", "HEAD"],
      undefined,
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      undefined,
      undefined,
      { timeoutMs: 30_000 },
    )
  ).trim();
  if (head !== commit)
    throw cellCodedError(
      "review_checkout_commit_mismatch",
      `Reviewer checkout ${cwd} is at ${head}, not the frozen delivery commit ${commit}; ` +
        "the cut must be reviewed at its frozen commit.",
    );
}

/**
 * A remote-edge checkout must judge its baseline against the current published main, not an old local ref.
 *
 * Only the default branch is fetched: its name already resolves locally (origin/HEAD, else the main
 * checkout's branch, through remoteDefaultBranch), so the refspec carries it and no other branch's
 * objects transfer. An unfiltered `fetch origin` also pulls every task branch, of which this
 * repository has dozens. When nothing local names a default branch, the unfiltered fetch is the only
 * way to ask the remote which branch that is, so that case keeps it.
 */
async function refreshDefaultBranch(rootDir: string): Promise<void> {
  // remoteDefaultBranch names the published copy (`origin/main`) or, unfetched, the local branch.
  const published = remoteDefaultBranch(rootDir),
    branch =
      published === null ? null : published.startsWith("origin/") ? published.slice("origin/".length) : published,
    refspec = branch ? `+refs/heads/${branch}:refs/remotes/origin/${branch}` : null;
  await runProcessExitAsync(
    "git",
    ["-C", rootDir, "fetch", "--quiet", "origin", ...(refspec ? [refspec] : [])],
    undefined,
    { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  ).then(
    () => undefined,
    () => undefined,
  );
}

// A checkout runs outside the repository write queue, so two starts, or a start and a dispatch, can reach one
// worktree at once. They take turns per worktree path: the later one finds the checkout and its finished steps.
const worktreeTurns = new Map<string, Promise<void>>();

function inWorktreeTurn<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const turn = (worktreeTurns.get(cwd) ?? Promise.resolve()).then(work),
    settled = turn.then(
      () => undefined,
      () => undefined,
    );
  worktreeTurns.set(cwd, settled);
  void settled.then(() => {
    if (worktreeTurns.get(cwd) === settled) worktreeTurns.delete(cwd);
  });
  return turn;
}

/** What a person reads about a successful checkout: where, which branch, from which base, what setup ran. */
export function taskWorktreeCheckoutNote(checkout: TaskWorktreeCheckout): string {
  const ran = checkout.setup.ok ? checkout.setup.ran : [];
  return [
    `Worktree ${checkout.cwd} is checked out on ${checkout.branch}`,
    checkout.baseRef ? ` from ${checkout.baseRef}. ` : ". ",
    ran.length ? `Setup ran: ${ran.join("; ")}. ` : "",
    managedByHarness,
  ].join("");
}

export interface TaskWorktreeLifecycleInput {
  readonly rootDir: string;
  readonly readTask: (taskId: string) => TaskV2 | null | undefined;
  readonly readPresetSnapshot: PresetSnapshotRead;
  readonly readWorktree: () => WorktreeSetupSettings;
  /** Stable acquisition revision after the start write; renewal leaves it unchanged. */
  readonly readLeaseAcquiredRevision?: (taskId: string, executionId: string) => number | null;
}

type TaskWorktreeAction = {
  readonly kind: string;
  readonly taskId?: unknown;
  readonly taskIds?: unknown;
  readonly executionId?: unknown;
  readonly dryRun?: unknown;
};

const executionBindingsDirectory = "harness-execution-bindings";

/** Node-local proof that the worktree was prepared for one execution. It lives in the worktree's
 * own git directory, so it never enters the ledger and cannot be forged by a document write. */
export interface TaskWorktreeExecutionBindingV2 {
  readonly schema: "task-worktree-execution-binding/v2";
  readonly taskId: string;
  readonly executionId: string;
  readonly acquiredRevision: number;
  readonly boundAt: string;
}

/** The latest canonical acquisition fences re-entry even when it reuses the execution id.
 * Lease CAS versions change on renewal; the interval's acquisition revision does not. */
export function taskLeaseAcquiredRevision(
  projection: Pick<TaskProjection, "readLeaseIntervals">,
  taskId: string,
  executionId: string,
): number | null {
  const interval = projection.readLeaseIntervals(taskId).at(-1);
  return interval?.executionId === executionId && interval.releasedRevision === null ? interval.acquiredRevision : null;
}

/** One file per execution: a rejected or competing start can only write its own id, never the
 * marker of the execution that currently holds the lease. */
export function taskWorktreeExecutionBindingPath(cwd: string, executionId: string): string {
  const gitPath = path.join(cwd, ".git"),
    gitDirectory = lstatSync(gitPath).isFile()
      ? path.resolve(cwd, /^gitdir: (.+)$/mu.exec(readFileSync(gitPath, "utf8"))![1]!.trim())
      : gitPath,
    fileName = `${Buffer.from(executionId, "utf8").toString("base64url")}.json`;
  return path.join(gitDirectory, executionBindingsDirectory, fileName);
}

export function writeTaskWorktreeExecutionBinding(
  cwd: string,
  taskId: string,
  executionId: string,
  acquiredRevision: number,
  boundAt = new Date().toISOString(),
): void {
  const file = taskWorktreeExecutionBindingPath(cwd, executionId),
    temporary = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  // A failed write may leave complete bytes behind. Only the successful rename publishes proof;
  // the previous marker remains fenced out by its acquisition revision if preparation/publication fails.
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify({
        schema: "task-worktree-execution-binding/v2",
        taskId,
        executionId,
        acquiredRevision,
        boundAt,
      })}\n`,
    );
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** A partial or corrupt file is `invalid`, not "no marker": the read must answer unobservable with
 * a named reason instead of throwing on a node-local write that was interrupted. */
export function readTaskWorktreeExecutionBinding(
  cwd: string,
  executionId: string,
): {
  readonly binding: TaskWorktreeExecutionBindingV2 | null;
  readonly invalid: boolean;
} {
  const file = taskWorktreeExecutionBindingPath(cwd, executionId);
  if (!existsSync(file)) return { binding: null, invalid: false };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { binding: null, invalid: true };
  }
  const binding =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { readonly schema?: unknown }).schema === "task-worktree-execution-binding/v2" &&
    typeof (value as { readonly taskId?: unknown }).taskId === "string" &&
    (value as { readonly taskId: string }).taskId.length > 0 &&
    typeof (value as { readonly executionId?: unknown }).executionId === "string" &&
    (value as { readonly executionId: string }).executionId.length > 0 &&
    Number.isInteger((value as { readonly acquiredRevision?: unknown }).acquiredRevision) &&
    Number((value as { readonly acquiredRevision: number }).acquiredRevision) >= 0 &&
    typeof (value as { readonly boundAt?: unknown }).boundAt === "string" &&
    (value as { readonly executionId: string }).executionId === executionId
      ? (value as TaskWorktreeExecutionBindingV2)
      : null;
  return { binding, invalid: binding === null };
}

/**
 * A start checks its worktree out and prepares it before the start is queued for writing, so a setup step that
 * fails or times out refuses the start while a long install never holds the repository write queue; the queue
 * receives only the start itself. The returned function adds what the checkout did to the applied start. Null
 * when the write starts no task on this node: only a locally executed write acts on this node's checkout — a
 * write forwarded from another node leaves that node's checkout to that node.
 */
export function prepareTaskStartWorktree(
  input: TaskWorktreeLifecycleInput,
  action: TaskWorktreeAction,
  source: unknown,
  stackedCommit?: string,
): Promise<(receipt: WriteReceipt) => WriteReceipt> | null {
  if (source !== "local" || action.dryRun === true || action.kind !== "task-start" || typeof action.taskId !== "string")
    return null;
  const executionId =
    typeof action.executionId === "string" && action.executionId.length > 0 ? action.executionId : null;
  return checkoutOnStart(input, action.taskId, stackedCommit).then((checkout) => (receipt) => {
    if (receipt.outcome !== "applied") return receipt;
    // Authorization and the lifecycle CAS already succeeded. The marker is published last, and a
    // write failure is a warning on the applied receipt: reads stay unobservable rather than a
    // committed start being reported as rejected.
    let warnings = checkout.warnings;
    if (checkout.cwd !== null && executionId !== null) {
      try {
        const acquiredRevision = input.readLeaseAcquiredRevision?.(action.taskId as string, executionId);
        if (acquiredRevision === null || acquiredRevision === undefined) {
          warnings = [
            ...warnings,
            `Worktree ${checkout.cwd} was checked out but its lease generation was not readable. ` +
              "Execution reads for this start remain unobservable.",
          ];
        } else {
          writeTaskWorktreeExecutionBinding(checkout.cwd, action.taskId as string, executionId, acquiredRevision);
        }
      } catch (error) {
        consumeKnownError(error);
        warnings = [
          ...warnings,
          `Worktree ${checkout.cwd} was checked out but its execution marker was not written: ${errorText(error)}. ` +
            "Execution reads for this start remain unobservable.",
        ];
      }
    }
    return withNotes(receipt, checkout.notes, warnings);
  });
}

/**
 * An applied write that closes a task (done, cancelled, archived) reclaims its worktree on this node. A reclaim
 * failure never undoes the lifecycle write: it comes back as a warning. The same close retries every other closed
 * task's worktree still on this node, so one retained for uncommitted changes goes once it is clean; only its
 * removal is reported, since the write did not name it.
 */
export async function applyTaskWorktreeLifecycle(
  input: TaskWorktreeLifecycleInput,
  action: TaskWorktreeAction,
  source: unknown,
  write: () => Promise<WriteReceipt>,
): Promise<WriteReceipt> {
  const receipt = await write();
  if (receipt.outcome !== "applied" || source !== "local" || action.dryRun === true) return receipt;
  const taskIds =
    typeof action.taskId === "string"
      ? [action.taskId]
      : Array.isArray(action.taskIds)
        ? action.taskIds.filter((id): id is string => typeof id === "string")
        : [];
  if (
    !taskIds.some((taskId) => {
      const task = input.readTask(taskId);
      return task ? taskClosed(task) : false;
    })
  )
    return receipt;
  let settled = receipt;
  for (const row of await reconcileClosedTaskWorktrees(input, taskIds)) {
    if (row.result.outcome === "retained" && row.named) settled = withNotes(settled, [], [row.detail!]);
    else if (row.result.outcome === "removed")
      settled = withNotes(
        settled,
        [row.detail ?? `Worktree ${row.worktree.cwd} and branch ${row.worktree.branch} removed.`],
        [],
      );
  }
  return settled;
}

/** One reconciliation row: what this node still holds for a closed task, and what the reclaim did to it. */
export interface ReconciledTaskWorktree {
  readonly taskId: string;
  /** True when the closing write itself named this task, so a retained worktree is its warning to carry. */
  readonly named: boolean;
  readonly worktree: ManagedWorktree;
  readonly result: WorktreeReclaim;
  readonly detail: string | null;
}

/**
 * The reentrant reconciliation both a close and a daemon start run: every directory under this node's `.worktrees/`
 * names a task, and each task the ledger says is closed has its worktree reclaimed here and now. Inputs come from
 * the shared ledger; the directories are this node's own — each node reconciles only what it holds.
 */
export async function reconcileClosedTaskWorktrees(
  input: TaskWorktreeLifecycleInput,
  namedTaskIds: readonly string[] = [],
): Promise<readonly ReconciledTaskWorktree[]> {
  const rows: ReconciledTaskWorktree[] = [];
  for (const taskId of new Set([...namedTaskIds, ...worktreeDirectories(input.rootDir)])) {
    const task = input.readTask(taskId),
      binding = task && taskClosed(task) ? taskWorktreeBinding(task, input.readPresetSnapshot) : null,
      row = binding && (await reclaimClosedTaskWorktree(input.rootDir, taskId, binding));
    if (row) rows.push({ ...row, named: namedTaskIds.includes(taskId) });
  }
  return rows;
}

/**
 * Reclaims what this node holds for one closed task: the one rule a close, a daemon start and an edge's mirror
 * sync all end a task worktree by. Null when this node has no checkout of it, or no default branch to judge by.
 */
export async function reclaimClosedTaskWorktree(
  rootDir: string,
  taskId: string,
  binding: TaskWorktreeBindingV1,
): Promise<Omit<ReconciledTaskWorktree, "named"> | null> {
  const cwd = path.join(rootDir, binding.path),
    baseRef = existsSync(cwd) ? repositoryBaseRef(rootDir) : null;
  if (!baseRef) return null;
  const worktree: ManagedWorktree = { cwd, branch: binding.branch, baseRef },
    result = await reclaimManagedWorktree(rootDir, worktree);
  return { taskId, worktree, result, detail: reclaimDetail("Worktree", worktree, result) };
}

/** What a daemon start adds to the shared sweep: the orphan cancellations, and how the rows are reported. */
export interface StartupTaskWorktreeReconciliation {
  /** Cancels the child tasks rejected Squad attempts left behind; the caller's write surface owns how. */
  readonly cancelSquadOrphans: () => Promise<void> | void;
  /** Removals and retentions a person can find later; defaults to the daemon log with a [task-worktree] prefix. */
  readonly report?: (note: string, warning: boolean) => void;
}

/**
 * What a daemon start runs once per attached repository: the same reconciliation a close runs, with one addition a
 * close cannot make — the cancelling writes for rejected Squad children, which would deadlock inside a write turn.
 */
export async function reconcileAbandonedTaskWorktrees(
  input: TaskWorktreeLifecycleInput,
  startup: StartupTaskWorktreeReconciliation,
): Promise<void> {
  await startup.cancelSquadOrphans();
  const report =
    startup.report ?? ((note, warning) => (warning ? console.warn : console.log)(`[task-worktree] ${note}`));
  for (const row of await reconcileClosedTaskWorktrees(input)) {
    if (row.result.outcome === "absent") continue;
    report(
      row.detail ?? `Worktree ${row.worktree.cwd} and branch ${row.worktree.branch} removed.`,
      row.result.outcome === "retained",
    );
  }
}

/** The directories under this node's `.worktrees/`; each task-bound one is named by its task id. */
export function worktreeDirectories(rootDir: string): readonly string[] {
  const directory = path.join(rootDir, ".worktrees");
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
}

async function checkoutOnStart(
  input: TaskWorktreeLifecycleInput,
  taskId: string,
  stackedCommit?: string,
): Promise<{ readonly notes: readonly string[]; readonly warnings: readonly string[]; readonly cwd: string | null }> {
  const binding = openTaskWorktreeBinding(input.readTask(taskId), input.readPresetSnapshot);
  if (!binding) {
    if (stackedCommit !== undefined)
      throw cellCodedError("invalid_proof", "A stacked task requires a managed worktree.");
    return { notes: [], warnings: [], cwd: null };
  }
  let checkout: TaskWorktreeCheckout | null;
  try {
    checkout = await checkoutTaskWorktree(
      input.rootDir,
      taskId,
      binding,
      input.readWorktree(),
      undefined,
      stackedCommit,
    );
  } catch (error) {
    if (stackedCommit !== undefined) throw error;
    return { notes: [], warnings: [`Worktree ${binding.path} was not checked out: ${errorText(error)}`], cwd: null };
  }
  if (!checkout)
    return {
      notes: [`No worktree on this node: no default branch resolves here, so work stays in ${input.rootDir}.`],
      warnings: [],
      cwd: null,
    };
  if (!checkout.setup.ok)
    throw cellCodedError(
      "worktree_setup_failed",
      worktreeSetupFailure(checkout.cwd, checkout.setup, `run ha task start ${taskId} again`, checkout.baseRef),
    );
  return { notes: [taskWorktreeCheckoutNote(checkout)], warnings: [], cwd: checkout.cwd };
}

function withNotes(receipt: WriteReceipt, notes: readonly string[], warnings: readonly string[]): WriteReceipt {
  const summary = (receipt as { readonly summary?: unknown }).summary;
  return {
    ...receipt,
    ...(notes.length
      ? { summary: [typeof summary === "string" ? summary : null, ...notes].filter(Boolean).join("\n") }
      : {}),
    ...(warnings.length ? { warnings: [...(receipt.warnings ?? []), ...warnings] } : {}),
  };
}

/** Closed is the same judgment wherever the two fields come from: a projection here, a mirrored package on an edge. */
export function taskClosed(task: {
  readonly status: TaskV2["status"];
  readonly packageDisposition?: string | undefined;
}): boolean {
  return isTerminalStatus(task.status) || (task.packageDisposition ?? "active") !== "active";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Recheck the prepared immutable anchor immediately before runtime admission. */
export async function verifyHandoffWorktree(cwd: string, acceptedCommit: string): Promise<void> {
  const git = (...args: string[]) =>
    runProcessTextAsync(
      "git",
      ["-C", cwd, ...args],
      undefined,
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      undefined,
      undefined,
      { timeoutMs: 30_000 },
    );
  if ((await git("status", "--porcelain")).trim())
    throw cellCodedError("runtime_handoff_workspace_dirty", "Handoff requires a clean worktree.");
  if ((await git("rev-parse", "HEAD")).trim() !== acceptedCommit)
    throw cellCodedError("runtime_handoff_sha_mismatch", "Worktree HEAD differs from the accepted handoff SHA.");
}
