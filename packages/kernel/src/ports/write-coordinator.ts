import { Context, Effect } from "effect";
import type { DomainStatus, EntityId, WriteError } from "../domain/index.js";
export type { WriteOpKind } from "../domain/write-op-kind.ts";
import type { WriteOpKind } from "../domain/write-op-kind.ts";
import type { CurrentSessionRuntime } from "./current-session-probe.js";

export type DecisionWriteOpKind = Extract<WriteOpKind, `decision_${string}`>;
export type FactWriteOpKind = Extract<WriteOpKind, `fact_${string}`>;
export type RelationWriteOpKind = Extract<WriteOpKind, `relation_${string}`>;
export type ModuleWriteOpKind = Extract<WriteOpKind, `module_${string}`>;
export type MigrationWriteOpKind = Extract<WriteOpKind, `migration_${string}`>;
export type MachineArtifactWriteOpKind = Extract<WriteOpKind, `machine_artifact_${string}`>;
export type TaskWriteOpKind = Exclude<WriteOpKind,
  | DecisionWriteOpKind
  | FactWriteOpKind
  | RelationWriteOpKind
  | ModuleWriteOpKind
  | MigrationWriteOpKind
  | MachineArtifactWriteOpKind
>;

// BEGIN GENERATED WRITE-ROAD KIND DISCOVERY
// Generated for the existing write-road AST inventory. Do not edit.
type GeneratedWriteRoadWriteOpKind =
  | "package_create"
  | "transition_local"
  | "progress_append"
  | "doc_stage"
  | "task_tree_stage"
  | "doc_write"
  | "doc_sync_submit"
  | "code_doc_reconcile"
  | "package_archive"
  | "package_tombstone"
  | "package_reopen"
  | "package_supersede"
  | "package_delete_hard"
  | "decision_propose"
  | "decision_accept"
  | "decision_reject"
  | "decision_defer"
  | "decision_supersede"
  | "decision_amend"
  | "decision_relate"
  | "decision_retire"
  | "fact_invalidate"
  | "relation_retire"
  | "relation_replace"
  | "module_registry_write"
  | "module_scaffold_write"
  | "script_ingest"
  | "migration_retired_attribution_fields"
  | "machine_artifact_write"
  | "machine_artifact_append_jsonl";
true satisfies [GeneratedWriteRoadWriteOpKind] extends [WriteOpKind]
  ? ([WriteOpKind] extends [GeneratedWriteRoadWriteOpKind] ? true : never)
  : never;
// END GENERATED WRITE-ROAD KIND DISCOVERY

export type FlushReason = "debounce" | "count" | "explicit" | "shutdown" | "recovery";

export interface ProvenancePayload {
  readonly runtime: CurrentSessionRuntime;
  readonly sessionId: string;
  readonly boundAt: string;
}

export interface WriteOp {
  readonly opId: string;
  readonly entityId: EntityId;
  readonly kind: WriteOpKind;
  readonly payload?: unknown;
  readonly provenance?: ProvenancePayload;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
}

export interface AuthorityOperationIntegrity {
  readonly schema: "authority-operation-integrity/v2";
  readonly semanticRequestDigest: string;
  readonly semanticMutationSetDigest: string;
  readonly mutationRegistryVersion: number;
  readonly actorAxesBindingDigest: string;
  readonly canonicalMutationSet: AuthorityCanonicalMutationSet;
}

export interface AuthorityCanonicalMutationSet {
  readonly registryVersion: number;
  readonly mutations: ReadonlyArray<{
    readonly entity: { readonly registryVersion: number; readonly entityKind: string; readonly canonicalRef: string };
    readonly action: { readonly registryVersion: number; readonly action: string };
  }>;
}

export interface LocalTransitionWriteOp extends WriteOp {
  readonly kind: "transition_local";
  readonly to: DomainStatus;
}

export interface WriteAck {
  readonly opId: string;
  readonly entityId: EntityId;
  readonly accepted: true;
  /**
   * Exact durable journal identity observed by this coordinator after it
   * validated the submitted operation and attribution.
   */
  readonly journalWitness?: JournalRecordWitnessV1;
}

export interface JournalRecordWitnessV1 {
  readonly schema: "write-journal-record-witness/v1";
  readonly opId: string;
  readonly recordDigest: string;
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
  readonly deferredOps?: number;
}

export interface WriteCoordinator {
  readonly enqueue: (op: WriteOp) => Effect.Effect<WriteAck, WriteError>;
  readonly flush: (reason: FlushReason) => Effect.Effect<FlushReport, WriteError>;
  /**
   * Recovery-only boundary. It may publish only the journal record named by
   * the exact witness returned from this coordinator's validated enqueue.
   */
  readonly flushExactJournalRecord?: (
    reason: Extract<FlushReason, "recovery">,
    witness: JournalRecordWitnessV1
  ) => Effect.Effect<FlushReport, WriteError>;
  readonly recover: Effect.Effect<RecoveryReport, WriteError>;
}

export const WriteCoordinator = Context.GenericTag<WriteCoordinator>(
  "@harness-anything/kernel/WriteCoordinator"
);
