import { deriveTaskRoot } from "./task-wip-policy.ts";
import type { TaskClass, TaskWorktreeBindingV1 } from "./task.ts";

/**
 * dec_BBA713052997C3EF5F5D3DD952 CH1: a task whose output is a repository diff is bound to its own worktree when
 * it is created; a task-package artifact and a declared work root never are. The branch sits one segment below
 * codex/, the namespace runtime settlement publishes. The name carries the task id prefix because slugs repeat
 * (every title without Latin letters slugs to "task").
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
