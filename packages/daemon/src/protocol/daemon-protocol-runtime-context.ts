import type { TaskWorktreeBindingV1 } from "@harness-anything/kernel";

export type DaemonTaskRuntimeContextResult = {
  readonly schema: "task-runtime-context-read/v1";
  readonly ok: true;
  readonly taskId: string;
  readonly causalContext: string | null;
  readonly profileId: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
};
