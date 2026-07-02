import { Context, Effect } from "effect";
import type { DomainStatus, EntityId, WriteError } from "../domain/index.js";

export type TaskWriteOpKind =
  | "package_create"
  | "transition_local"
  | "progress_append"
  | "doc_write"
  | "package_archive"
  | "package_tombstone"
  | "package_reopen"
  | "package_supersede"
  | "package_delete_hard";

export type DecisionWriteOpKind =
  | "decision_propose"
  | "decision_accept"
  | "decision_reject"
  | "decision_defer"
  | "decision_supersede"
  | "decision_amend"
  | "decision_retire";

export type WriteOpKind = TaskWriteOpKind | DecisionWriteOpKind;

export type FlushReason = "debounce" | "count" | "explicit" | "shutdown" | "recovery";

export interface ProvenancePayload {
  readonly runtime: string;
  readonly sessionId: string;
  readonly boundAt: string;
}

export interface WriteOp {
  readonly opId: string;
  readonly entityId: EntityId;
  readonly kind: WriteOpKind;
  readonly payload?: unknown;
  readonly provenance?: ProvenancePayload;
}

export interface LocalTransitionWriteOp extends WriteOp {
  readonly kind: "transition_local";
  readonly to: DomainStatus;
}

export interface WriteAck {
  readonly opId: string;
  readonly entityId: EntityId;
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
