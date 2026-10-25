import type { TaskWorktreeBindingV1 } from "@harness-anything/kernel";
import type { Snapshot } from "../repo-cell-types.ts";
import type { TaskWorkspaceView } from "./daemon-protocol-gui-types.ts";
import type { RuntimeContinuationSeed } from "../runtime-continuation-context.ts";

export type DaemonTaskRuntimeContextResult = {
  readonly schema: "task-runtime-context-read/v3";
  readonly ok: true;
  readonly taskId: string;
  readonly causalContext: string | null;
  readonly riskTier: "low" | "medium" | "high" | null;
  readonly riskTierFlowVersion: 1 | null;
  readonly profileId: string | null;
  readonly worktree: TaskWorktreeBindingV1 | null;
  readonly continuationContext: RuntimeContinuationSeed | null;
  /** The reviewer note the worker mission names (dec_E369B861 CH3); null for reviewer bindings. */
  readonly reviewerNote: string | null;
  readonly snapshot: Snapshot & { readonly workspace: TaskWorkspaceView | null };
};
