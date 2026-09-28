import { deriveTaskRoot } from "./task-wip-policy.ts";
import type { TaskClass } from "./task.ts";

/**
 * The git worktree a repository-diff task works in (dec_BBA713052997C3EF5F5D3DD952). The center records only
 * the fields it derives from; the node that executes the task materializes and reclaims the checkout itself.
 */
export interface TaskWorktreeBindingV1 {
  readonly branch: string;
  /** Repository-relative checkout directory. */
  readonly path: string;
  readonly baseRef: string;
}

/**
 * dec_BBA713052997C3EF5F5D3DD952 CH1: a task whose output is a repository diff is bound to its own worktree when
 * it is created; a task-package artifact and a declared work root never are. The binding is not stored: every
 * input is fixed at creation, so each reader derives the same binding (dec_01KY4Y2MW94HM5QK5Q1208XJZ5). The
 * branch sits one segment below codex/, the namespace runtime settlement publishes. The name carries the task id
 * prefix because slugs repeat (every title without Latin letters slugs to "task").
 */
export function deriveTaskWorktreeBinding(input: {
  readonly taskId: string;
  readonly slug: string;
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
  const name = `${input.slug}-${input.taskId
    .replace(/^task[-_]/u, "")
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(0, 8)}`;
  return { branch: `codex/${name}`, path: `.worktrees/${name}`, baseRef: "origin/main" };
}
