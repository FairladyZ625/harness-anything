import type {
  AuthorityOperationEnvelope,
  AuthorityOperationRecord,
  AuthorityOperationReceipt,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "@harness-anything/application";

export type BrokerPathStatus =
  | "CLEAN"
  | "DIRTY"
  | "SUBMITTING"
  | "PENDING_UNKNOWN"
  | "CONFLICT"
  | "APPLY_BLOCKED"
  | "LOCAL_ONLY"
  | "UNTRACKED_DIRTY"
  | "ORIGIN_PINNED";

export interface ManagedFingerprint {
  readonly objectKind: "file" | "tombstone";
  readonly logicalMode: number;
  readonly byteSize: number;
  readonly blobDigest: string;
}

export interface BrokerVersion {
  readonly epoch: string;
  readonly revision: number;
  /** Ordered operation owners for this path in a grouped publication. */
  readonly lastChangeOpIds?: ReadonlyArray<string>;
  /** Compatibility alias for lastChangeOpIds[0]. */
  readonly lastChangeOpId: string | null;
  readonly commitSha: string | null;
  readonly fingerprint: ManagedFingerprint;
}

export interface BrokerPathState {
  readonly canonicalHidden: BrokerVersion;
  readonly visibleBase: BrokerVersion | null;
  readonly visibleWorkingFingerprint: ManagedFingerprint;
  readonly status: BrokerPathStatus;
  readonly overlayBase?: BrokerVersion | null;
  readonly pendingOpIds: ReadonlyArray<string>;
  readonly conflictId?: string;
  readonly applyBlockedReason?: string;
}

export interface PendingMaterialization {
  readonly path: string;
  readonly target: BrokerVersion;
}

export interface MaterializationWitness {
  readonly cutId: string;
  readonly selectedDigest: string;
  readonly cutKind: "HISTORICAL_EXCLUDED_SET";
  readonly epoch: string;
  readonly revision: number;
  readonly fingerprints: Readonly<Record<string, ManagedFingerprint>>;
  readonly watcherFenceVector: Readonly<Record<string, string>>;
  readonly journalLSN: number;
}

export interface BrokerDurableState {
  readonly schema: "broker-state/v1";
  readonly workspaceId: string;
  readonly epoch: string;
  readonly receivedCursor: number;
  readonly resolvedCursor: number;
  readonly receivedCommit: string | null;
  readonly resolvedCommit: string | null;
  readonly nextJournalLSN: number;
  readonly mode: "READY" | "RESYNC_REQUIRED";
  readonly paths: Readonly<Record<string, BrokerPathState>>;
  readonly pendingMaterializations: ReadonlyArray<PendingMaterialization>;
  readonly witnesses: Readonly<Record<string, MaterializationWitness>>;
}

export interface CanonicalSnapshotEntry {
  readonly path: string;
  readonly content: Uint8Array;
  readonly logicalMode?: number;
}

export interface CanonicalSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly entries: ReadonlyArray<CanonicalSnapshotEntry>;
}

export interface CanonicalSnapshotSource {
  readonly snapshotAt: (change: ReplicaChangeRecord) => Promise<CanonicalSnapshot>;
}

export interface WriterExclusionLease {
  readonly release: () => Promise<void>;
}

export interface WriterExclusion {
  readonly acquire: (paths: ReadonlyArray<string>) => Promise<WriterExclusionLease | undefined>;
}

export interface WatcherFence {
  readonly fence: (paths: ReadonlyArray<string>) => Promise<Readonly<Record<string, string>>>;
}

export interface BrokerBarrierRequest {
  readonly paths?: ReadonlyArray<string>;
  readonly targetRevision?: number;
  readonly fresh?: boolean;
}

export type BrokerBarrierResult =
  | { readonly tag: "SATISFIED_EXACT_AT_CUT"; readonly witness: MaterializationWitness }
  | { readonly tag: "DIRTY"; readonly paths: ReadonlyArray<string> }
  | { readonly tag: "LOCAL_CONFLICT"; readonly paths: ReadonlyArray<string> }
  | { readonly tag: "APPLY_BLOCKED"; readonly paths: ReadonlyArray<string> }
  | { readonly tag: "NONQUIESCENT" }
  | { readonly tag: "RESYNC_REQUIRED" }
  | { readonly tag: "TIMEOUT"; readonly resolvedCursor: number };

export interface AuthoritySubmissionClient {
  readonly submit: (envelope: AuthorityOperationEnvelope) => Promise<AuthorityOperationReceipt>;
  readonly getOperation: (opId: string) => Promise<AuthorityOperationRecord | undefined>;
}

export interface BrokerOptions {
  readonly workspaceId: string;
  readonly viewId: string;
  readonly viewRoot: string;
  readonly stateRoot: string;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly snapshotSource: CanonicalSnapshotSource;
  readonly writerExclusion?: WriterExclusion;
  readonly watcherFence?: WatcherFence;
  readonly crashInjector?: BrokerCrashInjector;
}

export type BrokerCrashPoint =
  | "after_intent"
  | "after_stage"
  | "after_old_retained"
  | "after_namespace_mutation"
  | "after_post_verify"
  | "after_apply_resolved"
  | "after_hidden_resolved";

export interface BrokerCrashInjector {
  readonly hit: (point: BrokerCrashPoint, path: string) => void | Promise<void>;
}
