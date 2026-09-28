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
import { runProcessTextAsync } from "./process-port.ts";
import type { TaskWorktreeView } from "./protocol/daemon-protocol-gui-types.ts";
import {
  addManagedWorktree,
  reclaimDetail,
  reclaimManagedWorktree,
  type ManagedWorktree,
} from "./schedule-occurrence-workspace.ts";

// dec_BBA713052997C3EF5F5D3DD952: a task's worktree binding follows from fields fixed at its creation; the node
// that runs the task checks it out on first start or dispatch and reclaims it when the task closes. There is no
// worktree command.

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

/** The binding is derived, never stored (dec_01KY4Y2MW94HM5QK5Q1208XJZ5): id, slug, class and output shape. */
export function taskWorktreeBinding(
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): TaskWorktreeBindingV1 | null {
  if (!task?.metadata || !task.presetSnapshotDigest) return null;
  const snapshot = readPresetSnapshot(task.presetSnapshotDigest) as {
      readonly profile?: { readonly outputShape?: unknown };
    } | null,
    outputShape = snapshot?.profile?.outputShape;
  return typeof outputShape === "string"
    ? deriveTaskWorktreeBinding({
        taskId: task.taskId,
        slug: task.metadata.slug,
        taskClass: task.taskClass,
        outputShape,
      })
    : null;
}

export function taskWorktreeView(
  rootDir: string,
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): TaskWorktreeView | null {
  const binding = taskWorktreeBinding(task, readPresetSnapshot);
  if (!task || !binding) return null;
  const present = existsSync(path.join(rootDir, binding.path));
  return {
    ...binding,
    state: present ? (taskClosed(task) ? "retained" : "materialized") : taskClosed(task) ? "reclaimed" : "bound",
  };
}

/**
 * Checks the bound worktree out on this node, or finds it already there. A node without the base ref (a Git-less
 * edge, a repository before its first commit or without origin) has no worktree to give: null, not a failure.
 */
export async function materializeTaskWorktree(
  rootDir: string,
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): Promise<{ readonly cwd: string; readonly note: string | null } | null> {
  const binding = taskWorktreeBinding(task, readPresetSnapshot);
  if (!task || !binding || taskClosed(task)) return null;
  const worktree = managedWorktree(rootDir, binding);
  if (existsSync(worktree.cwd)) return { cwd: worktree.cwd, note: null };
  if (!(await resolves(rootDir, worktree.baseRef))) return null;
  return { cwd: worktree.cwd, note: await addManagedWorktree(rootDir, worktree) };
}

const closingActions = new Set([
  "task-complete",
  "task-settle",
  "task-transition",
  "task-archive",
  "task-supersede",
  "task-delete",
]);

/**
 * The one place a task write reaches its worktree: an applied start materializes it and names it in the receipt;
 * an applied write that closes a task (done, cancelled, archived) reclaims it. Only a locally executed write acts
 * on this node's checkout — a write forwarded from another node leaves that node's checkout to that node. A
 * worktree failure never undoes the lifecycle write: it comes back as a warning.
 */
export async function applyTaskWorktreeLifecycle(
  rootDir: string,
  readTask: (taskId: string) => TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
  action: { readonly kind: string; readonly taskId?: unknown; readonly taskIds?: unknown; readonly dryRun?: unknown },
  source: unknown,
  receipt: WriteReceipt,
): Promise<WriteReceipt> {
  if (receipt.outcome !== "applied" || source !== "local" || action.dryRun === true) return receipt;
  if (action.kind === "task-start" && typeof action.taskId === "string") {
    const checkout = await checkoutOnStart(rootDir, readTask(action.taskId), readPresetSnapshot);
    return withNotes(receipt, checkout.notes, checkout.warnings);
  }
  if (!closingActions.has(action.kind)) return receipt;
  const taskIds =
    typeof action.taskId === "string"
      ? [action.taskId]
      : Array.isArray(action.taskIds)
        ? action.taskIds.filter((id): id is string => typeof id === "string")
        : [];
  let settled = receipt;
  for (const taskId of taskIds) {
    const task = readTask(taskId),
      binding = taskWorktreeBinding(task, readPresetSnapshot);
    if (!task || !binding || !taskClosed(task)) continue;
    const worktree = managedWorktree(rootDir, binding),
      result = await reclaimManagedWorktree(rootDir, worktree),
      detail = reclaimDetail("Worktree", worktree, result);
    if (result.outcome === "retained") settled = withNotes(settled, [], [detail!]);
    else if (result.outcome === "removed")
      settled = withNotes(settled, [detail ?? `Worktree ${worktree.cwd} and branch ${worktree.branch} removed.`], []);
  }
  return settled;
}

async function checkoutOnStart(
  rootDir: string,
  task: TaskV2 | null | undefined,
  readPresetSnapshot: PresetSnapshotRead,
): Promise<{ readonly notes: readonly string[]; readonly warnings: readonly string[] }> {
  const binding = taskWorktreeBinding(task, readPresetSnapshot);
  if (!binding) return { notes: [], warnings: [] };
  try {
    const materialized = await materializeTaskWorktree(rootDir, task, readPresetSnapshot);
    return {
      notes: materialized
        ? [`Worktree ${materialized.cwd} is checked out on ${binding.branch}. ${managedByHarness}`]
        : [`No worktree on this node: ${binding.baseRef} does not resolve here, so work stays in ${rootDir}.`],
      warnings: materialized?.note ? [materialized.note] : [],
    };
  } catch (error) {
    return { notes: [], warnings: [`Worktree ${binding.path} was not checked out: ${errorText(error)}`] };
  }
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

function managedWorktree(rootDir: string, binding: TaskWorktreeBindingV1): ManagedWorktree {
  return { cwd: path.join(rootDir, binding.path), branch: binding.branch, baseRef: binding.baseRef };
}

function resolves(rootDir: string, ref: string): Promise<boolean> {
  return runProcessTextAsync("git", ["-C", rootDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
    () => true,
    () => false,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
