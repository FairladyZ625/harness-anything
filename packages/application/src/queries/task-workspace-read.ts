import path from "node:path";
import {
  deriveTaskWorktreeBinding,
  isTerminalStatus,
  type TaskProjection,
  type TaskV2,
  type TaskWorktreeBindingV1,
} from "@harness-anything/kernel";
import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";

/** Reads a preset snapshot by digest: the task's profile output shape is one input of its binding. */
export type PresetSnapshotRead = (digest: string) => unknown;

export type TaskWorkspaceView =
  | {
      readonly kind: "worktree";
      readonly branch: string;
      readonly path: string;
      readonly state: OperationalStatus.TaskWorkspaceState;
    }
  | { readonly kind: "task-package"; readonly path: string };

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

/** Closed is the same judgment wherever the two fields come from: a projection here, a mirrored package on an edge. */
export function taskClosed(task: {
  readonly status: TaskV2["status"];
  readonly packageDisposition?: string | undefined;
}): boolean {
  return isTerminalStatus(task.status) || (task.packageDisposition ?? "active") !== "active";
}

/**
 * dec_8B3FCCD256CAC5B0BF3CCEDE58 CH4: every task has one place it works in — its worktree when it changes
 * repository files, otherwise its own task package directory.
 * `linkedWorktree` is omitted on a node that has no checkout: the state is then bound or reclaimed.
 */
export function taskWorkspaceView(
  rootDir: string,
  task: TaskV2 | null | undefined,
  packagePath: string | null,
  readPresetSnapshot: PresetSnapshotRead,
  /** The authored root, resolved once by the caller; null where only a worktree is shown (the agenda reads no files). */
  authoredRoot: string | null,
  linkedWorktree: (absolutePath: string) => boolean = () => false,
): TaskWorkspaceView | null {
  const binding = taskWorktreeBinding(task, readPresetSnapshot);
  if (task && binding) {
    const present = linkedWorktree(path.join(rootDir, binding.path));
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
