import type {
  AuthorityOperationIntegrity,
  WriteAttribution,
  WriteCoordinator,
  WriteOp
} from "../../../kernel/src/index.ts";
import type { AuthorizedOperationAttemptV2 } from "./semantic-mutation-envelope-v2.ts";

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
}

export interface AuthorityRejectedReceipt {
  readonly tag: "REJECTED";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly reason: string;
}

export interface AuthorityRetryableReceipt {
  readonly tag: "RETRYABLE_NOT_COMMITTED";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly reason: string;
}

export interface AuthorityIndeterminateReceipt {
  readonly tag: "INDETERMINATE";
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly reason: string;
  readonly commitSha?: string;
}

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
}

export interface AuthorityStoredOperationRecord extends AuthorityOperationRecord {
  readonly canonicalRequestEnvelope?: string;
}

export interface AuthorityOperationRegistry {
  readonly get: (workspaceId: string, opId: string) => Promise<AuthorityStoredOperationRecord | undefined>;
  readonly put: (record: AuthorityStoredOperationRecord) => Promise<void>;
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
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
}

export interface ReplicaChangeLog {
  readonly append: (record: ReplicaChangeRecord) => Promise<void>;
  readonly latest: (workspaceId: string) => Promise<ReplicaChangeRecord | undefined>;
  readonly getByOperation: (workspaceId: string, opId: string) => Promise<ReplicaChangeRecord | undefined>;
  readonly changesAfter: (workspaceId: string, revision: number) => Promise<ReadonlyArray<ReplicaChangeRecord>>;
}

export interface CanonicalPublication {
  readonly commitSha: string;
  readonly parentCommits: ReadonlyArray<string>;
}

export interface CanonicalPublicationInspector {
  readonly currentHead: () => Promise<string | null>;
  readonly inspectPublishedHead: (expectedPreviousHead: string | null) => Promise<CanonicalPublication>;
}

export interface AuthorityFenceWitness {
  readonly assertHeld: () => Promise<void>;
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
