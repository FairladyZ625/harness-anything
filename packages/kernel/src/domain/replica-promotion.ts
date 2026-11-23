export interface PromotableReplicaIntegrityInput {
  readonly expectedRepoId: string;
  readonly actualRepoId: string;
  readonly expectedGeneration: number;
  readonly actualGeneration: number;
  readonly expectedHistory: string;
  readonly actualHistory: string;
  readonly expectedSequence: number;
  readonly actualSequence: number;
  readonly expectedPositionRevision: number;
  readonly actualPositionRevision: number;
  readonly metadataRevision: number;
  readonly ledgerRevision: number;
  readonly lastEventRevision: number;
  readonly eventSequenceComplete: boolean;
  readonly eventDigestsValid: boolean;
  readonly contentDigestsValid: boolean;
}

export type PromotableReplicaIntegrityIssue =
  | "repository_mismatch"
  | "generation_mismatch"
  | "lineage_mismatch"
  | "invalid_lineage"
  | "invalid_sequence"
  | "revision_mismatch"
  | "event_prefix_incomplete"
  | "event_digest_invalid"
  | "content_digest_invalid";

export function validatePromotableReplica(
  input: PromotableReplicaIntegrityInput,
): readonly PromotableReplicaIntegrityIssue[] {
  const issues: PromotableReplicaIntegrityIssue[] = [];
  if (input.actualRepoId !== input.expectedRepoId) issues.push("repository_mismatch");
  if (input.actualGeneration !== input.expectedGeneration || input.actualGeneration !== 3)
    issues.push("generation_mismatch");
  if (
    input.actualHistory !== input.expectedHistory ||
    input.actualSequence !== input.expectedSequence ||
    input.actualPositionRevision !== input.expectedPositionRevision
  )
    issues.push("lineage_mismatch");
  if (!/^[0-9a-f]{32}$/u.test(input.actualHistory)) issues.push("invalid_lineage");
  if (!Number.isSafeInteger(input.actualSequence) || input.actualSequence < 0) issues.push("invalid_sequence");
  if (
    input.ledgerRevision !== input.metadataRevision ||
    input.ledgerRevision !== input.actualPositionRevision ||
    !Number.isSafeInteger(input.ledgerRevision) ||
    input.ledgerRevision < 0
  )
    issues.push("revision_mismatch");
  if (!input.eventSequenceComplete || input.lastEventRevision !== input.ledgerRevision)
    issues.push("event_prefix_incomplete");
  if (!input.eventDigestsValid) issues.push("event_digest_invalid");
  if (!input.contentDigestsValid) issues.push("content_digest_invalid");
  return issues;
}
