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

const journaledBatchEntryBrand: unique symbol = Symbol("JournaledBatchEntry");
const journaledBatchBrand: unique symbol = Symbol("JournaledBatch");
const exactWriteScopeBrand: unique symbol = Symbol("ExactWriteScope");
const journaledBatchEntries = new WeakMap<JournaledBatchEntry, {
  readonly owner: object;
  readonly acknowledgement: WriteAck;
}>();
const journaledBatches = new WeakMap<JournaledBatch, ReadonlyArray<JournaledBatchEntry>>();
const exactWriteScopeOwners = new WeakMap<ExactWriteScope, object>();

/** Shared opaque ownership for coordinators participating in one exact authority batch. */
export interface ExactWriteScope {
  readonly [exactWriteScopeBrand]: true;
}

/** Opaque membership capability minted inside one exact write scope. */
export interface JournaledBatchEntry extends WriteAck {
  readonly [journaledBatchEntryBrand]: true;
}

/** Non-empty exact publication batch. Construct with createJournaledBatch. */
export interface JournaledBatch {
  readonly opIds: readonly [string, ...string[]];
  readonly [journaledBatchBrand]: true;
}

export interface JournalRecordWitnessV1 {
  readonly schema: "write-journal-record-witness/v1";
  readonly opId: string;
  readonly recordDigest: string;
}

export interface DeterminateFlushReport {
  readonly reason: FlushReason;
  readonly opCount: number;
  readonly committed: boolean;
  readonly watermark?: string;
  readonly publicationMode?: "exact-batch" | "integrity-domain";
  readonly canonicalCommitSha?: string;
}

type FlushLockHolderSnapshot = {
  readonly lockPath: string;
} & (
  | {
    readonly status: "observed";
    readonly pid: number;
    readonly hostname: string;
    readonly acquiredAt: string;
    readonly heartbeatAt: string;
    readonly ownerKind?: "daemon";
    readonly repoId?: string;
    readonly canonicalRoot?: string;
    readonly endpoint?: string;
  }
  | {
    readonly status: "missing" | "unreadable";
    readonly detail: string;
  }
);

type IndeterminateFlushCause =
  | {
    readonly kind: "foreign-committer";
    readonly detail: string;
    readonly lockHolder: FlushLockHolderSnapshot;
  }
  | {
    readonly kind: "authority";
    readonly workspaceId: string;
    readonly semanticDigest: string;
    readonly evidence: string;
    readonly observedCommitSha?: string;
    readonly errorCode?: string;
    readonly errorContext?: Readonly<Record<string, unknown>>;
  };

/**
 * The omitted determinate fields are deliberate and load-bearing. In particular,
 * this report must not expose `committed`, `watermark`, `canonicalCommitSha`, or
 * `publicationMode`: consumers have to narrow the union before using the legacy
 * boolean result, so an unknown terminal outcome cannot silently enter an old
 * success/failure default branch. DeterminateFlushReport keeps the legacy shape
 * unchanged because `committed: false` still covers no-op and dry-run outcomes;
 * it does not mean that the write failed.
 */
export interface IndeterminateFlushReport {
  readonly status: "indeterminate";
  readonly reason: FlushReason;
  readonly opCount: number;
  readonly operationIds: readonly [string, ...string[]];
  readonly cause: IndeterminateFlushCause;
}

export type FlushReport = DeterminateFlushReport | IndeterminateFlushReport;

export interface IndeterminateFlushControlOutcome {
  readonly _tag: "IndeterminateFlushControlOutcome";
  readonly report: IndeterminateFlushReport;
}

export type WriteControl = WriteError | IndeterminateFlushControlOutcome;

export function isIndeterminateFlushReport(
  report: FlushReport
): report is IndeterminateFlushReport {
  return "status" in report && report.status === "indeterminate";
}

export function isIndeterminateFlushControlOutcome(
  outcome: unknown
): outcome is IndeterminateFlushControlOutcome {
  return typeof outcome === "object"
    && outcome !== null
    && "_tag" in outcome
    && outcome._tag === "IndeterminateFlushControlOutcome"
    && "report" in outcome
    && typeof outcome.report === "object"
    && outcome.report !== null;
}

export interface RecoveryReport {
  readonly replayedOps: number;
  readonly recoveredWatermark?: string;
  readonly deferredOps?: number;
}

/** Daemon-owned global-lock capability accepted by coordinated write runtimes. */
export interface DaemonGlobalLock {
  readonly path: string;
  readonly ownerToken: string;
  readonly ownerKind?: "daemon";
  readonly refreshHeartbeat: () => void;
  readonly release: () => void;
}

export interface WriteCoordinator {
  readonly enqueue: (op: WriteOp) => Effect.Effect<WriteAck, WriteError>;
  readonly flush: (reason: FlushReason) => Effect.Effect<FlushReport, WriteError>;
  /**
   * Publishes only the durable journal records named by witnesses returned
   * from this coordinator's validated enqueue calls.
   */
  readonly flushExactJournalRecords?: (
    reason: FlushReason,
    witnesses: ReadonlyArray<JournalRecordWitnessV1>
  ) => Effect.Effect<FlushReport, WriteError>;
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

/** Authority-facing capability: broad flush is deliberately absent. */
export interface ExactWriteCoordinator {
  readonly enqueue: (op: WriteOp) => Effect.Effect<JournaledBatchEntry, WriteError>;
  readonly commitExact: (
    reason: FlushReason,
    batch: JournaledBatch
  ) => Effect.Effect<FlushReport, WriteError>;
  readonly recover: Effect.Effect<RecoveryReport, WriteError>;
}

export type ExactCapableWriteCoordinator = Omit<WriteCoordinator, "enqueue"> & ExactWriteCoordinator;

export function createExactWriteScope(): ExactWriteScope {
  const scope = Object.freeze({ [exactWriteScopeBrand]: true as const });
  exactWriteScopeOwners.set(scope, Object.freeze({}));
  return scope;
}

export function createJournaledBatch(
  entries: readonly [JournaledBatchEntry, ...JournaledBatchEntry[]]
): JournaledBatch {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw invalidExactBatch(
      "authority_exact_batch_empty",
      "Authority publication requires a non-empty exact journal batch."
    );
  }
  const opIds: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !journaledBatchEntries.has(entry)) {
      throw invalidExactBatch(
        "authority_exact_batch_entry_invalid",
        "Authority publication requires entries minted by the kernel exact-write boundary."
      );
    }
    opIds.push(entry.opId);
  }
  if (new Set(opIds).size !== opIds.length) {
    throw invalidExactBatch(
      "authority_exact_batch_duplicate_operation",
      "Authority publication exact journal batch entries must have unique operation ids."
    );
  }
  const batch = Object.freeze({
    opIds: Object.freeze(opIds) as readonly [string, ...string[]],
    [journaledBatchBrand]: true as const
  });
  journaledBatches.set(batch, Object.freeze([...entries]));
  return batch;
}

/**
 * Adds an opaque exact-batch boundary around a coordinator-specific enqueue
 * and commit implementation. A batch containing an entry minted outside the
 * supplied exact scope fails closed before the implementation sees it.
 */
export function withExactCommit<Coordinator extends {
  readonly enqueue: (op: WriteOp) => Effect.Effect<WriteAck, WriteError>;
  readonly recover: Effect.Effect<RecoveryReport, WriteError>;
}>(
  coordinator: Coordinator,
  commit: (
    reason: FlushReason,
    acknowledgements: readonly [WriteAck, ...WriteAck[]]
  ) => Effect.Effect<FlushReport, WriteError>,
  scope: ExactWriteScope = createExactWriteScope()
): Omit<Coordinator, "enqueue"> & ExactWriteCoordinator {
  const owner = exactWriteScopeOwners.get(scope);
  if (!owner) {
    throw invalidExactBatch(
      "authority_exact_scope_invalid",
      "Exact write scope must be created by the kernel constructor."
    );
  }
  return {
    ...coordinator,
    enqueue: (op) => coordinator.enqueue(op).pipe(Effect.map((acknowledgement) => {
      const entry = Object.freeze({
        ...acknowledgement,
        [journaledBatchEntryBrand]: true as const
      });
      journaledBatchEntries.set(entry, { owner, acknowledgement });
      return entry;
    })),
    commitExact: (reason, batch) => Effect.suspend(() => {
      const entries = journaledBatches.get(batch);
      if (!entries) {
        return Effect.fail(invalidExactBatch(
          "authority_exact_batch_invalid",
          "Authority publication requires a JournaledBatch created by the kernel constructor."
        ));
      }
      const acknowledgements: WriteAck[] = [];
      for (const entry of entries) {
        const internal = journaledBatchEntries.get(entry);
        if (!internal || internal.owner !== owner) {
          return Effect.fail(invalidExactBatch(
            "authority_exact_batch_owner_mismatch",
            "Authority publication cannot combine entries minted by different exact write scopes."
          ));
        }
        acknowledgements.push(internal.acknowledgement);
      }
      return commit(
        reason,
        acknowledgements as [WriteAck, ...WriteAck[]]
      );
    })
  };
}

function invalidExactBatch(code: string, reason: string): WriteError {
  return {
    _tag: "WriteRejected",
    code,
    reason,
    retryable: false
  };
}

export const WriteCoordinator = Context.GenericTag<WriteCoordinator>(
  "@harness-anything/kernel/WriteCoordinator"
);
