import { deriveTaskRoot } from "./task-wip-policy.ts";
import type { TaskClass } from "./task.ts";

/**
 * The git worktree a repository-diff task works in (dec_BBA713052997C3EF5F5D3DD952). The center records only
 * the fields it derives from; the node that executes the task materializes and reclaims the checkout itself,
 * cutting it from that repository's own default branch (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH2).
 */
export interface TaskWorktreeBindingV1 {
  readonly branch: string;
  /** Repository-relative checkout directory. */
  readonly path: string;
}

/**
 * dec_BBA713052997C3EF5F5D3DD952 CH1: a task whose output is a repository diff is bound to its own worktree when
 * it is created; a task-package artifact and a declared work root never are. The binding is not stored: every
 * input is fixed at creation, so each reader derives the same binding (dec_01KY4Y2MW94HM5QK5Q1208XJZ5).
 * dec_8B3FCCD256CAC5B0BF3CCEDE58 CH1: branch and directory are the full task id, so a name found anywhere is
 * already the argument to `ha task show`.
 */
export function deriveTaskWorktreeBinding(input: {
  readonly taskId: string;
  readonly taskClass: TaskClass;
  readonly outputShape: string;
}): TaskWorktreeBindingV1 | null {
  if (input.outputShape !== "repository-diff") return null;
  const root = deriveTaskRoot({
    taskId: input.taskId,
    title: "",
    status: "planned",
    taskClass: input.taskClass,
    packageDisposition: "active",
    hasCloseoutEvidence: false,
    hasOwnExecution: false,
    directChildCount: 0,
  });
  if (root.isRoot) return null;
  return { branch: input.taskId, path: `.worktrees/${input.taskId}` };
}
