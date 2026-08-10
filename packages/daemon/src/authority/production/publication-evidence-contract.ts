import type { CanonicalPublicationInspector } from "@harness-anything/application";
import type { PhysicalChangeV2 } from "@harness-anything/kernel";

export interface CanonicalPublicationEvidence {
  /** Ordered operation group encoded by the canonical publication anchor. */
  readonly opIds: ReadonlyArray<string>;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly parentCommits: ReadonlyArray<string>;
  readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
  readonly pipelineGeneratedPaths: ReadonlyArray<string>;
  readonly contentAddressedPaths: ReadonlyArray<string>;
}

export interface GitCanonicalPublicationInspector extends CanonicalPublicationInspector {
  readonly shutdown: () => Promise<void>;
  readonly inspectPublication: (
    expectedPreviousHead: string | null,
    expectedOpIds: ReadonlyArray<string>,
    expectedCommitSha?: string
  ) => Promise<CanonicalPublicationEvidence>;
  readonly findPublication: (expectedOpIds: ReadonlyArray<string>) => Promise<CanonicalPublicationEvidence>;
  readonly findPublicationForOperation: (opId: string) => Promise<CanonicalPublicationEvidence>;
  readonly findDurableSuccessorPublicationForOperation: (
    opId: string,
    expectedCommitSha: string
  ) => Promise<CanonicalPublicationEvidence>;
  readonly findDurableSuccessorTopologyForOperation: (
    opId: string,
    expectedCommitSha: string
  ) => Promise<CanonicalPublicationEvidence>;
  readonly findHistoricalPublicationForOperation: (opId: string) => Promise<{
    readonly commitSha: string;
    readonly semanticDigest: string;
  }>;
  readonly scanFirstParentOperationAnchors: (input: {
    readonly exclusiveCommit?: string;
    readonly interestedOpIds: ReadonlySet<string>;
    readonly progressBatchSize?: number;
    readonly onProgress?: (progress: FirstParentOperationAnchorScanProgress) => Promise<void>;
  }) => Promise<FirstParentOperationAnchorScan>;
}

export interface FirstParentOperationAnchor {
  readonly commitSha: string;
  readonly previousCommit: string;
  readonly opIds: ReadonlyArray<string>;
}

export interface FirstParentOperationAnchorScan {
  readonly headCommit: string | null;
  readonly scannedCommitCount: number;
  readonly anchors: ReadonlyArray<FirstParentOperationAnchor>;
  readonly unanchoredOperationIds?: ReadonlyArray<string>;
}

export interface FirstParentOperationAnchorScanProgress {
  /** The newest commit in a fully inspected, oldest-to-newest scan batch. */
  readonly commitSha: string;
  readonly scannedCommitCount: number;
  readonly anchors: ReadonlyArray<FirstParentOperationAnchor>;
  readonly unanchoredOperationIds?: ReadonlyArray<string>;
}

export class AuthorityCanonicalPublicationNotFoundError extends Error {
  readonly opId: string;

  constructor(opId: string) {
    super(`AUTHORITY_CANONICAL_PUBLICATION_NOT_FOUND:expectedOpId=${opId}`);
    this.name = "AuthorityCanonicalPublicationNotFoundError";
    this.opId = opId;
  }
}

export class AuthorityRecoveryWatermarkInvalidError extends Error {
  constructor(commitSha: string) {
    super(`AUTHORITY_RECOVERY_WATERMARK_INVALID:commitSha=${commitSha}`);
    this.name = "AuthorityRecoveryWatermarkInvalidError";
  }
}

export interface GitAuthorityAttributionEvidenceCommitterV2 {
  readonly commitPending: (canonicalCommitSha: string) => Promise<void>;
}
