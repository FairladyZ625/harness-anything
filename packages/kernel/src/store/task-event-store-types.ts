import { type CanonicalEventV1, type LedgerCommitSha } from "../domain/doc-sync.contract.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import {
  type ActorIdentity,
  type EventHead,
  type FrozenWritePlan,
  type LedgerCutIdentity,
  type WriteSource,
} from "../domain/write-chain.contract.ts";
import { type LedgerLayoutState } from "../layout/ledger-object-layout.ts";

// Public store contract, publication records, and write-bundle shapes.
export const CANONICAL_EVENT_REF = "refs/ha/canonical";
export type TaskEventStoreErrorCode =
  | "invalid_store"
  | "invalid_write_plan"
  | "legacy_shape"
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
  readonly body: string;
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
  readonly body: string;
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
export interface EventRecoveryReceipt {
  readonly status: "none" | "committed" | "already_committed" | "indeterminate";
  readonly publications: 0 | 1;
  readonly elapsedMs: number;
  readonly error?: string;
  readonly errorCode?: string;
}
export interface EventFileBatch {
  readonly sourceRevision: number;
  readonly events: readonly CanonicalEventV1[];
  readonly cursor: string | null;
  readonly done: boolean;
  readonly accessedItems: number;
  readonly prefetchContent?: (events: readonly CanonicalEventV1[]) => ReadonlyMap<string, Uint8Array | null>;
}
export interface MaterializationReceipt {
  readonly status: "visible";
  readonly commitSha: LedgerCommitSha;
  readonly changed: readonly string[];
  readonly conflicts: readonly string[];
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
  readonly readLedgerEpoch: () => number;
  readonly currentCut: () => LedgerCutIdentity;
  readonly currentCommit: () => LedgerCommitSha;
  readonly publication: (event: CanonicalEventV1) => CanonicalPublicationIdentity;
  readonly revisionAt: (commit: LedgerCommitSha) => number | null;
  readonly readEvent: (opId: string) => CanonicalEventV1 | null;
  readonly readTaskEvent: (opId: string) => TaskEventV1 | null;
  readonly readBatch: (cursor: string | null, maxItems: number) => EventFileBatch;
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
  readonly layout: () => LedgerLayoutState;
  readonly append: (
    bundle: CanonicalWriteBundle,
    additionalFiles?: readonly PublicationFile[],
  ) => CanonicalEventAppendReceipt;
  readonly migrateLayout: (input: {
    readonly actor: ActorIdentity;
    readonly source: WriteSource;
    readonly occurredAt: string;
  }) => CanonicalEventAppendReceipt;
  readonly recover: () => EventRecoveryReceipt;
  readonly materialize: () => MaterializationReceipt;
  readonly drain: () => Promise<void>;
}
