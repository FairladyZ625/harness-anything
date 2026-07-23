import type {
  ActorAxesBindingCoreV2,
  AttributionEventV2,
  AuthorityOperationIntegrity,
  WriteAttribution,
  WriteCoordinator,
  WriteOp
} from "@harness-anything/kernel";
import type { AuthorizedOperationAttemptV2 } from "./semantic-mutation-envelope-v2.ts";
import type { ProtocolSchemaTupleV2 } from "./actor-axes-binding-v2.ts";

export const authorityProtocolTuple = {
  wire: 1,
  event: 1,
  receipt: 1,
  digest: 1,
  commandRegistry: 1
} as const;

export interface AuthorityProtocolTuple {
  readonly wire: number;
  readonly event: number;
  readonly receipt: number;
  readonly digest: number;
  readonly commandRegistry: number;
}

export interface AuthorityOperationEnvelope {
  readonly workspaceId: string;
  readonly opId: string;
  readonly claimedDigest: string;
  readonly command: string;
  readonly operation: WriteOp;
  readonly delegationToken: string;
  readonly channelNonceDigest: string;
  readonly protocol: AuthorityProtocolTuple;
}

export interface DelegationTokenClaims {
  readonly tokenId: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly workspaceId: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly actorId: string;
  readonly executorId: string | null;
  readonly sessionId: string;
  readonly authorityGeneration: number;
  readonly channelNonceDigest: string;
  readonly protocol: AuthorityProtocolTuple;
  readonly commandScopes: ReadonlyArray<string>;
  readonly pathScopes: ReadonlyArray<string>;
  readonly maxBytes: number;
  readonly maxOps: number;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly revocationEpoch: number;
}

export interface DelegationTokenVerification {
  readonly claims: DelegationTokenClaims;
  readonly attribution: WriteAttribution;
}

export interface DelegationTokenVerifier {
  readonly verify: (input: {
    readonly token: string;
    readonly envelope: Omit<AuthorityOperationEnvelope, "delegationToken">;
  }) => Promise<DelegationTokenVerification>;
}

export type AuthorityOperationState =
  | "RECEIVED"
  | "PREPARED"
  | "PUBLISHED"
  | "INDEXED"
  | "COMMITTED"
  | "REJECTED"
  | "RETRYABLE_NOT_COMMITTED"
  | "INDETERMINATE";

export interface AuthorityCommittedReceipt {
  readonly tag: "COMMITTED";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
  readonly integrityTuple?: AuthorityIntegrityTupleV2;
}

export interface AuthorityIntegrityTupleV2 {
  readonly schema: "authority-integrity-tuple/v2";
  readonly canonicalEventDigest: string;
  readonly changeSetDigest: string;
  readonly semanticMutationSetDigest: string;
  readonly actorAxesBindingDigest: string;
}

/**
 * Publishes the complete attribution event before a V2 COMMITTED receipt is
 * made externally visible. Implementations own the durable event boundary and
 * must return the exact event that was persisted.
 */
export interface AuthorityCommittedEventPublisherV2 {
  readonly publish: (input: {
    readonly receipt: AuthorityCommittedReceipt;
    readonly actorAxesBinding: ActorAxesBindingCoreV2;
    readonly occurredAt: string;
  }) => Promise<AttributionEventV2>;
}

export interface AuthorityRejectedReceipt {
  readonly tag: "REJECTED";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly reason: string;
}

export type AuthorityRetryableReceipt = {
  readonly tag: "RETRYABLE_NOT_COMMITTED";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly reason: string;
} & ({
  readonly errorCode?: undefined;
  readonly errorContext?: undefined;
} | {
  readonly errorCode: "DAEMON_GENERATION_FENCED";
  readonly errorContext: DaemonGenerationWriteRejectionV1;
});

export type AuthorityIndeterminateReceipt = {
  readonly tag: "INDETERMINATE";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly reason: string;
  readonly commitSha?: string;
} & ({
  readonly errorCode?: undefined;
  readonly errorContext?: undefined;
} | {
  readonly errorCode: "DAEMON_GENERATION_FENCED";
  readonly errorContext: DaemonGenerationWriteRejectionV1;
});

export type AuthorityOperationReceipt =
  | AuthorityCommittedReceipt
  | AuthorityRejectedReceipt
  | AuthorityRetryableReceipt
  | AuthorityIndeterminateReceipt;

export interface AuthorityOperationRecord {
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly state: AuthorityOperationState;
  readonly receipt?: AuthorityOperationReceipt;
  readonly commitSha?: string;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
  readonly recordedProtocol?: RecordedAuthorityProtocol;
}

export type RecordedAuthorityProtocol =
  | { readonly kind: "authority-operation/v1"; readonly schemaTuple: AuthorityProtocolTuple }
  | { readonly kind: "semantic-mutation-envelope/v2"; readonly schemaTuple: ProtocolSchemaTupleV2 };

export interface AuthorityStoredOperationRecord extends AuthorityOperationRecord {
  readonly canonicalRequestEnvelope?: string;
}

export interface AuthorityOperationRegistry {
  readonly get: (workspaceId: string, opId: string) => Promise<AuthorityStoredOperationRecord | undefined>;
  readonly put: (record: AuthorityStoredOperationRecord) => Promise<void>;
  readonly list: (workspaceId: string) => Promise<ReadonlyArray<AuthorityStoredOperationRecord>>;
}

export type Sha256Digest = `sha256:${string}`;
export type ReplicaFileMode = "100644" | "100755" | "120000";

export interface ReplicaManifestReference {
  readonly digest: Sha256Digest;
  readonly entryCount: number;
}

export interface ReplicaPathChange {
  readonly path: string;
  readonly blobDigest: Sha256Digest | null;
  readonly mode: ReplicaFileMode | null;
  readonly tombstone: boolean;
}

export interface ReplicaChangeRecord {
  readonly schema: "replica-change/v1";
  readonly workspaceId: string;
  readonly revision: number;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly changedAt: string;
  readonly manifest: ReplicaManifestReference;
  readonly paths: ReadonlyArray<ReplicaPathChange>;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
}

export type ReplicaChangeDraft = Omit<ReplicaChangeRecord, "manifest" | "paths"> & {
  readonly manifest?: ReplicaManifestReference;
  readonly paths?: ReadonlyArray<ReplicaPathChange>;
};

export type ReplicaChangeListener = (record: ReplicaChangeRecord) => void;

export interface ReplicaChangeLog {
  readonly append: (record: ReplicaChangeDraft) => Promise<void>;
  readonly latest: (workspaceId: string) => Promise<ReplicaChangeRecord | undefined>;
  readonly getByOperation: (workspaceId: string, opId: string) => Promise<ReplicaChangeRecord | undefined>;
  readonly changesAfter: (workspaceId: string, revision: number) => Promise<ReadonlyArray<ReplicaChangeRecord>>;
  readonly subscribe: (workspaceId: string, listener: ReplicaChangeListener) => () => void;
}

export interface AuthoritySnapshotCut {
  readonly workspaceId: string;
  readonly epoch: string;
  readonly revision: number;
  readonly commitSha: string;
  readonly manifestDigest: Sha256Digest;
  readonly provenanceDigest: Sha256Digest;
}

export interface AuthoritySnapshotLease {
  readonly leaseId: string;
  readonly expiresAt: string;
  readonly minRetainedRevision: number;
  readonly pinnedBlobSetDigest: Sha256Digest;
}

export interface AuthorityStreamReservation {
  readonly streamToken: string;
  readonly fromRevision: number;
}

export interface AuthoritySnapshotReservation {
  readonly schema: "authority-snapshot-reservation/v1";
  readonly cut: AuthoritySnapshotCut;
  readonly lease: AuthoritySnapshotLease;
  readonly stream: AuthorityStreamReservation;
}

export interface AuthoritySnapshotManifestEntry extends Omit<ReplicaPathChange, "blobDigest" | "mode" | "tombstone"> {
  readonly blobDigest: Sha256Digest;
  readonly mode: ReplicaFileMode;
  readonly tombstone: false;
}

export interface AuthoritySnapshotManifest {
  readonly schema: "authority-snapshot-manifest/v1";
  readonly cut: AuthoritySnapshotCut;
  readonly entries: ReadonlyArray<AuthoritySnapshotManifestEntry>;
}

export interface CanonicalPublication {
  readonly commitSha: string;
  readonly parentCommits: ReadonlyArray<string>;
}

export interface CanonicalPublicationInspector {
  readonly currentHead: () => Promise<string | null>;
  readonly inspectPublishedHead: (
    expectedPreviousHead: string | null,
    expectedOpIds: ReadonlyArray<string>
  ) => Promise<CanonicalPublication>;
}

export interface AuthorityFenceWitness {
  readonly assertHeld: (
    stage?: AuthorityFenceStage,
    context?: { readonly workspaceId: string; readonly opId: string }
  ) => Promise<void>;
}

export interface AuthorityGenerationFence extends AuthorityFenceWitness {
  readonly runExclusive: <Result>(
    stage: AuthorityFenceStage,
    context: { readonly workspaceId: string; readonly opId: string },
    operation: () => Promise<Result>
  ) => Promise<Result>;
}

export type AuthorityFenceStage =
  | "before-prepare"
  | "before-canonical-publish"
  | "after-canonical-publish"
  | "before-terminal-visibility"
  | "before-terminal-journal";

export interface DaemonGenerationWriteRejectionV1 {
  readonly schema: "daemon-generation-write-rejection/v1";
  readonly machineId: string;
  readonly attemptedDaemonGeneration: number;
  readonly currentDaemonGeneration?: number;
  readonly runtimeRegistrationId?: string;
  readonly connectionId?: string;
  readonly workspaceId: string;
  readonly opId?: string;
  readonly stage: AuthorityFenceStage;
}

export interface AttributedCoordinatorFactory {
  readonly create: (input: {
    readonly attribution: WriteAttribution;
    readonly sessionId: string;
  }) => WriteCoordinator;
}

export interface AuthoritySubmissionService {
  readonly submit: (envelope: AuthorityOperationEnvelope) => Promise<AuthorityOperationReceipt>;
  readonly submitV2?: (attempt: AuthorizedOperationAttemptV2) => Promise<AuthorityOperationReceipt>;
  readonly getOperation: (workspaceId: string, opId: string) => Promise<AuthorityOperationRecord | undefined>;
}
