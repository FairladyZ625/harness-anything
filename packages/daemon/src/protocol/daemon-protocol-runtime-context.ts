import type { TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import type { Snapshot } from "../repo-cell-types.ts";
import type { TaskWorkspaceView } from "./daemon-protocol-gui-types.ts";

export type DaemonTaskRuntimeContextResult = {
  readonly schema: "task-runtime-context-read/v1";
  readonly ok: true;
  readonly taskId: string;
  readonly causalContext: string | null;
  readonly profileId: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
  readonly snapshot: Snapshot & { readonly workspace: TaskWorkspaceView | null };
};
