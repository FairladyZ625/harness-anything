import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  deriveTaskWorktreeBinding,
  isTerminalStatus,
  type TaskProjection,
  type TaskV2,
  type TaskWorktreeBindingV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";
import { runProcessTextAsync } from "./process-port.ts";
import type { TaskWorkspaceView } from "./protocol/daemon-protocol-gui-types.ts";
import {
  addManagedWorktree,
  advanceIdleCheckout,
  continuePublishedBranch,
  publishedBranchRef,
  reclaimDetail,
  reclaimManagedWorktree,
  repositoryBaseRef,
  type ManagedWorktree,
  type WorktreeReclaim,
} from "./schedule-occurrence-workspace.ts";
import { runWorktreeSetup, worktreeSetupFailure, type WorktreeSetupResult } from "./worktree-setup.ts";

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
  task: TaskV2 | null | undefined,
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
    const present = existsSync(path.join(rootDir, binding.path));
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
 * from the center (dec_57370FF2021DADF04E3B21724D CH2). A checkout continues the task's own branch — a new one
 * starts from the copy another node pushed before the default branch, an existing one is brought up to it (CH3);
 * with no pushed copy, an existing one that never worked is advanced to the present default branch instead, so a
 * checkout a refused or cancelled dispatch left behind never pins its retry to a stale baseline. A node
 * without a default branch (a Git-less edge, a repository before its first commit) has no worktree to give: null,
 * not a failure.
 * An accepted handoff commit instead requires that exact, retrievable SHA and a clean checkout before and after
 * setup. An existing checkout at another commit is preserved and refused.
 */
export async function checkoutTaskWorktree(
  rootDir: string,
  taskId: string,
  binding: TaskWorktreeBindingV1,
  setup: readonly string[],
  acceptedCommit?: string,
): Promise<TaskWorktreeCheckout | null> {
  const cwd = path.join(rootDir, binding.path);
  return inWorktreeTurn(cwd, async () => {
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
      const prepared = await runWorktreeSetup({ rootDir, cwd, taskId, steps: setup });
      await verify();
      return { cwd, branch: binding.branch, baseRef: fresh ? acceptedCommit : null, setup: prepared };
    }
    const fresh = !existsSync(cwd),
      defaultRef = repositoryBaseRef(rootDir);
    if (fresh && !defaultRef) return null;
    const published = await publishedBranchRef(rootDir, binding.branch);
    if (fresh) await addManagedWorktree(rootDir, { cwd, branch: binding.branch, baseRef: published ?? defaultRef! });
    // A checkout this node already had, or a branch that survived one, may predate another node's push.
    if (published) await continuePublishedBranch(cwd, published);
    // With no published task branch to continue, a checkout a refused or cancelled dispatch cut may also predate
    // the default branch itself: one that never worked is advanced, so the retry starts on the present baseline.
    else if (defaultRef) await advanceIdleCheckout(cwd, defaultRef);
    return {
      cwd,
      branch: binding.branch,
      baseRef: fresh ? (published ?? defaultRef) : null,
      setup: await runWorktreeSetup({ rootDir, cwd, taskId, steps: setup }),
    };
  });
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
  readonly readSetup: () => readonly string[];
}

type TaskWorktreeAction = {
  readonly kind: string;
  readonly taskId?: unknown;
  readonly taskIds?: unknown;
  readonly dryRun?: unknown;
};

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
): Promise<(receipt: WriteReceipt) => WriteReceipt> | null {
  if (source !== "local" || action.dryRun === true || action.kind !== "task-start" || typeof action.taskId !== "string")
    return null;
  return checkoutOnStart(input, action.taskId).then(
    (checkout) => (receipt) =>
      receipt.outcome === "applied" ? withNotes(receipt, checkout.notes, checkout.warnings) : receipt,
  );
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
): Promise<{ readonly notes: readonly string[]; readonly warnings: readonly string[] }> {
  const binding = openTaskWorktreeBinding(input.readTask(taskId), input.readPresetSnapshot);
  if (!binding) return { notes: [], warnings: [] };
  let checkout: TaskWorktreeCheckout | null;
  try {
    checkout = await checkoutTaskWorktree(input.rootDir, taskId, binding, input.readSetup());
  } catch (error) {
    return { notes: [], warnings: [`Worktree ${binding.path} was not checked out: ${errorText(error)}`] };
  }
  if (!checkout)
    return {
      notes: [`No worktree on this node: no default branch resolves here, so work stays in ${input.rootDir}.`],
      warnings: [],
    };
  if (!checkout.setup.ok)
    throw cellCodedError(
      "worktree_setup_failed",
      worktreeSetupFailure(checkout.cwd, checkout.setup, `run ha task start ${taskId} again`, checkout.baseRef),
    );
  return { notes: [taskWorktreeCheckoutNote(checkout)], warnings: [] };
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
