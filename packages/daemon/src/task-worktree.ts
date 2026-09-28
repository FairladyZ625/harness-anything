import { existsSync } from "node:fs";
import path from "node:path";
import {
  isTerminalStatus,
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

// dec_BBA713052997C3EF5F5D3DD952: the ledger records a task's worktree binding; the node that runs the task
// checks it out on first start or dispatch and reclaims it when the task closes. There is no worktree command.

const managedByHarness = "Harness manages this worktree; no command is needed.";

export function taskWorktreeView(rootDir: string, task: TaskV2 | null | undefined): TaskWorktreeView | null {
  if (!task?.worktree) return null;
  const present = existsSync(path.join(rootDir, task.worktree.path));
  return {
    ...task.worktree,
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
): Promise<{ readonly cwd: string; readonly note: string | null } | null> {
  if (!task?.worktree || taskClosed(task)) return null;
  const worktree = managedWorktree(rootDir, task.worktree);
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
  action: { readonly kind: string; readonly taskId?: unknown; readonly taskIds?: unknown; readonly dryRun?: unknown },
  source: unknown,
  receipt: WriteReceipt,
): Promise<WriteReceipt> {
  if (receipt.outcome !== "applied" || source !== "local" || action.dryRun === true) return receipt;
  if (action.kind === "task-start" && typeof action.taskId === "string") {
    const checkout = await checkoutOnStart(rootDir, readTask(action.taskId));
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
    const task = readTask(taskId);
    if (!task?.worktree || !taskClosed(task)) continue;
    const worktree = managedWorktree(rootDir, task.worktree),
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
): Promise<{ readonly notes: readonly string[]; readonly warnings: readonly string[] }> {
  try {
    const materialized = await materializeTaskWorktree(rootDir, task);
    return {
      notes: materialized
        ? [`Worktree ${materialized.cwd} is checked out on ${task!.worktree!.branch}. ${managedByHarness}`]
        : task?.worktree
          ? [`No worktree on this node: ${task.worktree.baseRef} does not resolve here, so work stays in ${rootDir}.`]
          : [],
      warnings: materialized?.note ? [materialized.note] : [],
    };
  } catch (error) {
    return { notes: [], warnings: [`Worktree ${task!.worktree!.path} was not checked out: ${errorText(error)}`] };
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
