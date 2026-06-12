import { Context, Effect } from "effect";
import type { DomainStatus, TaskId, WriteError } from "../domain/index.js";

export type WriteOpKind =
  | "package_create"
  | "transition_local"
  | "progress_append"
  | "doc_write"
  | "package_archive"
  | "package_tombstone"
  | "package_reopen"
  | "package_supersede"
  | "package_delete_hard";

export type FlushReason = "debounce" | "count" | "explicit" | "shutdown" | "recovery";

export interface WriteOp {
  readonly opId: string;
  readonly taskId: TaskId;
  readonly kind: WriteOpKind;
  readonly payload?: unknown;
}

export interface LocalTransitionWriteOp extends WriteOp {
  readonly kind: "transition_local";
  readonly to: DomainStatus;
}

export interface WriteAck {
  readonly opId: string;
  readonly taskId: TaskId;
  readonly accepted: true;
}

export interface FlushReport {
  readonly reason: FlushReason;
  readonly opCount: number;
  readonly committed: boolean;
  readonly watermark?: string;
}

export interface RecoveryReport {
  readonly replayedOps: number;
  readonly recoveredWatermark?: string;
}

export interface WriteCoordinator {
  readonly enqueue: (op: WriteOp) => Effect.Effect<WriteAck, WriteError>;
  readonly flush: (reason: FlushReason) => Effect.Effect<FlushReport, WriteError>;
  readonly recover: Effect.Effect<RecoveryReport, WriteError>;
}

export const WriteCoordinator = Context.GenericTag<WriteCoordinator>(
  "@harness-anything/kernel/WriteCoordinator"
);
