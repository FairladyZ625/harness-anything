import { type CanonicalEventV1, type LedgerCommitSha } from "../domain/doc-sync.contract.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import { type EventHead, type FrozenWritePlan, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { type LedgerLayoutState } from "../layout/ledger-object-layout.ts";

// Public store contract, publication records, and write-bundle shapes.
export const CANONICAL_EVENT_REF = "refs/ha/canonical";
export type TaskEventStoreErrorCode =
  | "invalid_store"
  | "invalid_write_plan"
  | "legacy_shape"
  | "materialization_failed"
  | "op_conflict"
  | "repo_mismatch"
  | "revision_conflict"
  | "publication_indeterminate";
export class TaskEventStoreError extends Error {
  readonly code: TaskEventStoreErrorCode;
  constructor(code: TaskEventStoreErrorCode, message: string) {
    super(message);
    this.name = "TaskEventStoreError";
    this.code = code;
  }
}
export interface CanonicalEventStreamV1 {
  readonly schema: "canonical-event-stream/v1";
  readonly revision: number;
  readonly events: readonly CanonicalEventV1[];
}
export interface PublicationMetrics {
  readonly gitProcesses: number;
  readonly nodeSyncs: number;
  readonly changedPaths: readonly string[];
}
export interface CanonicalEventCut extends LedgerCutIdentity {
  readonly opId: string;
  readonly headDigest: `sha256:${string}`;
}
export interface CanonicalPublicationIdentity {
  readonly commitSha: LedgerCommitSha | null;
  readonly cut: CanonicalEventCut;
}
export type CanonicalEventAppendReceipt = {
  readonly status: "applied";
  readonly event: CanonicalEventV1;
  readonly revision: number;
  readonly commitSha: LedgerCommitSha | null;
  readonly cut: CanonicalEventCut;
  readonly metrics: PublicationMetrics;
};
export interface CanonicalContentBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly body: string | Uint8Array;
}
export interface CanonicalEventWriteBundle {
  readonly event: CanonicalEventV1;
  readonly plan: FrozenWritePlan;
  readonly blobs: readonly CanonicalContentBlob[];
}
export interface CanonicalWriteBundle extends CanonicalEventWriteBundle {
  /**
   * Events that must land immediately before this event in the same publication.
   * Each member has its own complete write declaration; nesting is intentionally
   * unavailable so a publication has one explicit, contiguous event sequence.
   */
  readonly preceding?: readonly CanonicalEventWriteBundle[];
}
export type GitFileMode = "100644" | "120000";
export interface PublicationWrite {
  readonly target: string;
  readonly body: string | Uint8Array;
  readonly mode: GitFileMode;
}
export interface PublicationRename {
  readonly from: string;
  readonly to: string;
}
export interface PublicationDelete {
  readonly delete: string;
}
export type PublicationFile = PublicationWrite | PublicationRename | PublicationDelete;
export interface EventFileBatch {
  readonly sourceRevision: number;
  readonly events: readonly CanonicalEventV1[];
  readonly cursor: string | null;
  readonly done: boolean;
  readonly accessedItems: number;
  readonly prefetchContent?: (events: readonly CanonicalEventV1[]) => ReadonlyMap<string, Uint8Array | null>;
}
export interface MaterializationSettlement {
  /** The authored document path this row describes, relative to the authored root. */
  readonly path: string;
  readonly action: "overwrite" | "restore" | "delete";
  /** Where the overwritten local bytes were kept; null when nothing local was kept. */
  readonly copy: string | null;
}
/** A worktree target whose overwritten bytes live on in a conflict copy beside it. */
export interface PreservedCopy {
  readonly target: string;
  readonly copy: string;
}
export interface MaterializationReceipt {
  /** "planned" rows describe what a settlement would touch without changing any file. */
  readonly status: "visible" | "planned";
  readonly commitSha: LedgerCommitSha;
  /** Documents this pass settled, in authored-relative paths; a settled no-op pass reports none. */
  readonly settlements: readonly MaterializationSettlement[];
  /** Targets left alone because a concurrent local edit owns them, in authored-relative paths. */
  readonly conflicts: readonly string[];
}
export interface MaterializationRequest {
  /** Restrict the restore to these authored document paths; omitted settles the whole closure. */
  readonly paths?: readonly string[];
  /** Report what a whole-closure settlement would touch without changing any file. */
  readonly preview?: boolean;
}
export const materializationStates = Object.freeze(["ok", "retrying", "failed"] as const);
export type MaterializationState = (typeof materializationStates)[number];
export type MaterializationFailureReason = "git_diverged" | "deterministic_failure" | "retry_budget_exhausted";
export interface MaterializationHealth {
  readonly state: MaterializationState;
  readonly lastCheckpointRevision: number;
  readonly lastCheckpointAt: string | null;
  readonly pendingWalEvents: number;
  readonly retryElapsedMs?: number;
  readonly reason?: MaterializationFailureReason;
  readonly lastError?: string;
}
export interface CanonicalCommandOutcome {
  readonly opId: string;
  readonly status: "accepted_durable" | "rejected";
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly recordedAt: string;
  readonly memberOpIds: readonly string[];
}
export interface CanonicalFollowerFacet {
  readonly status: "pending" | "verified";
  readonly cut: LedgerCutIdentity | null;
  readonly commitSha: string | null;
  readonly reason?: string;
  readonly conflicts?: readonly string[];
}
export type EventPublicationKillpoint =
  | "before_event_write"
  | "after_event_write"
  | "after_head_write"
  | "after_git_commit"
  | "after_git_ref_update"
  | "before_worktree_rename"
  | "after_worktree_rename"
  | "after_sqlite_commit"
  | "before_response_write"
  | "after_response_write";
export interface CanonicalEventStore {
  readonly canonicalRef: string;
  readonly read: () => CanonicalEventStreamV1;
  readonly readHead: () => EventHead | null;
  readonly currentCut: () => LedgerCutIdentity;
  readonly currentCommit: () => LedgerCommitSha;
  readonly publication: (event: CanonicalEventV1) => CanonicalPublicationIdentity;
  readonly revisionAt: (commit: LedgerCommitSha) => number | null;
  readonly readEvent: (opId: string) => CanonicalEventV1 | null;
  readonly readEventAtRevision?: (revision: number) => CanonicalEventV1 | null;
  readonly readTaskEvent: (opId: string) => TaskEventV1 | null;
  readonly readCommandOutcome: (opId: string) => CanonicalCommandOutcome | null;
  readonly ledgerMetadata: () => { readonly repoId: string; readonly generation: number; readonly revision: number };
  readonly followerStatus: () => {
    readonly git: CanonicalFollowerFacet;
    readonly worktree: CanonicalFollowerFacet;
  };
  readonly readBatch: (cursor: string | null, maxItems: number) => EventFileBatch;
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
  readonly layout: () => LedgerLayoutState;
  readonly append: (bundle: CanonicalWriteBundle) => CanonicalEventAppendReceipt;
  /**
   * Layout roots the most recent accepted append resolved, so receipt prose reuses the write's own
   * view of the workspace instead of re-reading harness.yaml per rendered path. Null until this
   * store accepts an append in the current process; in-memory fakes may omit it and callers fall
   * back to resolving the layout themselves.
   */
  readonly lastAppendLayout?: () => { readonly rootDir: string; readonly authoredRoot: string } | null;
  readonly materialize: (request?: MaterializationRequest) => MaterializationReceipt;
  /** Read-only health of the WAL to Git materialization owned by this store. */
  readonly materializationHealth: () => MaterializationHealth;
  readonly drain: () => Promise<void>;
  readonly settlePendingMaterialization?: (context: string) => Promise<void>;
}
