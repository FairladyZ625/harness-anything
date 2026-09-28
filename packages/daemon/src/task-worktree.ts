import { existsSync } from "node:fs";
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
import type { TaskWorkspaceView } from "./protocol/daemon-protocol-gui-types.ts";
import {
  addManagedWorktree,
  reclaimDetail,
  reclaimManagedWorktree,
  repositoryBaseRef,
  type ManagedWorktree,
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

/** The binding is derived, never stored (dec_01KY4Y2MW94HM5QK5Q1208XJZ5): id, class and output shape. */
export function taskWorktreeBinding(
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): TaskWorktreeBindingV1 | null {
  if (!task?.presetSnapshotDigest) return null;
  const snapshot = readPresetSnapshot(task.presetSnapshotDigest) as {
      readonly profile?: { readonly outputShape?: unknown };
    } | null,
    outputShape = snapshot?.profile?.outputShape;
  return typeof outputShape === "string"
    ? deriveTaskWorktreeBinding({ taskId: task.taskId, taskClass: task.taskClass, outputShape })
    : null;
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
  /** The default branch a new checkout was cut from; null when the worktree was already here. */
  readonly baseRef: string | null;
  readonly setup: WorktreeSetupResult;
}

/**
 * Checks the bound worktree out on this node, or finds it already there, then runs the Settings setup steps that
 * have not succeeded in it yet. A node without a default branch (a Git-less edge, a repository before its first
 * commit) has no worktree to give: null, not a failure.
 */
export async function materializeTaskWorktree(
  rootDir: string,
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
  setup: readonly string[],
): Promise<TaskWorktreeCheckout | null> {
  const binding = taskWorktreeBinding(task, readPresetSnapshot);
  if (!task || !binding || taskClosed(task)) return null;
  const cwd = path.join(rootDir, binding.path);
  return inWorktreeTurn(cwd, async () => {
    let baseRef: string | null = null;
    if (!existsSync(cwd)) {
      baseRef = repositoryBaseRef(rootDir);
      if (!baseRef) return null;
      await addManagedWorktree(rootDir, { cwd, branch: binding.branch, baseRef });
    }
    return {
      cwd,
      branch: binding.branch,
      baseRef,
      setup: await runWorktreeSetup({ rootDir, cwd, taskId: task.taskId, steps: setup }),
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

const closingActions = new Set([
  "task-complete",
  "task-settle",
  "task-transition",
  "task-archive",
  "task-supersede",
  "task-delete",
]);

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
 * failure never undoes the lifecycle write: it comes back as a warning.
 */
export async function applyTaskWorktreeLifecycle(
  input: TaskWorktreeLifecycleInput,
  action: TaskWorktreeAction,
  source: unknown,
  write: () => Promise<WriteReceipt>,
): Promise<WriteReceipt> {
  const receipt = await write();
  if (receipt.outcome !== "applied" || source !== "local" || action.dryRun === true || !closingActions.has(action.kind))
    return receipt;
  const taskIds =
    typeof action.taskId === "string"
      ? [action.taskId]
      : Array.isArray(action.taskIds)
        ? action.taskIds.filter((id): id is string => typeof id === "string")
        : [];
  let settled = receipt;
  for (const taskId of taskIds) {
    const task = input.readTask(taskId),
      binding = taskWorktreeBinding(task, input.readPresetSnapshot),
      cwd = binding && task && taskClosed(task) ? path.join(input.rootDir, binding.path) : null,
      baseRef = cwd && existsSync(cwd) ? repositoryBaseRef(input.rootDir) : null;
    if (!binding || !cwd || !baseRef) continue;
    const worktree: ManagedWorktree = { cwd, branch: binding.branch, baseRef },
      result = await reclaimManagedWorktree(input.rootDir, worktree),
      detail = reclaimDetail("Worktree", worktree, result);
    if (result.outcome === "retained") settled = withNotes(settled, [], [detail!]);
    else if (result.outcome === "removed")
      settled = withNotes(settled, [detail ?? `Worktree ${worktree.cwd} and branch ${worktree.branch} removed.`], []);
  }
  return settled;
}

async function checkoutOnStart(
  input: TaskWorktreeLifecycleInput,
  taskId: string,
): Promise<{ readonly notes: readonly string[]; readonly warnings: readonly string[] }> {
  const task = input.readTask(taskId),
    binding = taskWorktreeBinding(task, input.readPresetSnapshot);
  if (!binding) return { notes: [], warnings: [] };
  let checkout: TaskWorktreeCheckout | null;
  try {
    checkout = await materializeTaskWorktree(input.rootDir, task, input.readPresetSnapshot, input.readSetup());
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

function taskClosed(task: TaskV2): boolean {
  return isTerminalStatus(task.status) || (task.packageDisposition ?? "active") !== "active";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
