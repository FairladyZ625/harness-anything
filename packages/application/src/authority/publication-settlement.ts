import { isIndeterminateFlushReport, type FlushReport } from "@harness-anything/kernel";
import type { PreparedAuthoritySubmission } from "./service-admission-types.ts";
import type {
  AuthorityCommittedPhysicalObservationV2,
  AuthorityOperationRegistry,
  CanonicalPublicationInspector,
  ReplicaChangeDraft,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "./types.ts";
import type { AuthorityPublicationExecutionContext } from "./service-options.ts";
import {
  createReplicaPublicationChange,
  type ReplicaPublicationOperation
} from "./replica-publication-change.ts";

export async function inspectAuthoritySettlementPublication(input: {
  readonly inspector: CanonicalPublicationInspector;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly candidates: ReadonlyArray<PreparedAuthoritySubmission>;
  readonly execution: AuthorityPublicationExecutionContext;
  readonly publicationReport?: FlushReport;
  readonly previousHead: string | null;
}): Promise<{
  readonly commitSha: string;
  readonly previousHead: string | null;
  readonly operations: ReadonlyArray<ReplicaPublicationOperation>;
  readonly observation?: AuthorityCommittedPhysicalObservationV2;
}> {
  const expectedOpIds = input.candidates.map((entry) => entry.opId);
  const exactCommitSha = input.publicationReport && !isIndeterminateFlushReport(input.publicationReport)
    ? input.publicationReport.canonicalCommitSha
    : undefined;
  const successorLookup = input.inspector.findDurableSuccessorTopologyForOperation
    ?? input.inspector.findDurableSuccessorPublicationForOperation
    ?? (input.inspector.findPublicationForOperation
      ? (opId: string) => input.inspector.findPublicationForOperation!(opId)
      : input.inspector.findPublication
        ? () => input.inspector.findPublication!(expectedOpIds)
        : undefined);
  const membershipLookup = input.inspector.findPublicationTopologyForOperation;
  // A single publication must inspect the current canonical head so a legal
  // head advance racing proof remains honestly indeterminate. Only an
  // explicitly admitted durable successor from the same outer command may
  // prove its already-known commit by membership after HEAD has advanced.
  const inspectExactCommit = Boolean(
    input.execution.allowDurableSuccessor && exactCommitSha && successorLookup
  );
  const inspectMembership = Boolean(
    input.execution.allowDurableSuccessor && !inspectExactCommit && membershipLookup
  );
  const inspectIndexedCommit = inspectExactCommit || inspectMembership;
  let publication = inspectExactCommit
    ? await successorLookup!(expectedOpIds[0]!, exactCommitSha!)
    : inspectMembership
      ? await membershipLookup!(expectedOpIds[0]!)
    : await input.inspector.inspectPublishedHead(input.previousHead, expectedOpIds);
  if (!inspectIndexedCommit) {
    const headAfterInspection = await input.inspector.currentHead();
    const closingHead = await input.inspector.currentHead();
    if (headAfterInspection !== publication.commitSha || closingHead !== headAfterInspection) {
      // Re-inspect the advanced head so the terminal receipt retains the full
      // topology evidence instead of certifying a stale, formerly-current
      // commit. A non-linear legal advance is therefore INDETERMINATE.
      publication = await input.inspector.inspectPublishedHead(publication.commitSha, expectedOpIds);
    }
  }
  if (inspectExactCommit && exactCommitSha
    && publication.commitSha !== exactCommitSha) {
    throw new Error(
      `AUTHORITY_CANONICAL_PUBLICATION_COMMIT_MISMATCH:expected=${exactCommitSha};actual=${publication.commitSha}`
    );
  }
  if (!inspectIndexedCommit) {
    return {
      commitSha: publication.commitSha,
      previousHead: input.previousHead,
      operations: input.candidates,
      ...(publication.physicalChanges && publication.physicalChanges.length > 0
        ? {
            observation: {
              opIds: publication.opIds ?? expectedOpIds,
              commitSha: publication.commitSha,
              previousCommit: publication.previousCommit ?? input.previousHead,
              physicalChanges: publication.physicalChanges,
              pipelineGeneratedPaths: publication.pipelineGeneratedPaths ?? [],
              contentAddressedPaths: publication.contentAddressedPaths ?? []
            }
          }
        : {})
    };
  }
  if (publication.parentCommits.length !== 2) {
    throw new Error("AUTHORITY_CANONICAL_PUBLICATION_SUCCESSOR_TOPOLOGY_INVALID");
  }
  const publicationOpIds = publication.opIds ?? expectedOpIds;
  if (expectedOpIds.some((opId) => !publicationOpIds.includes(opId))) {
    throw new Error("AUTHORITY_CANONICAL_PUBLICATION_OPERATION_GROUP_MISMATCH");
  }
  const workspaceId = input.candidates[0]!.workspaceId;
  const operations = await Promise.all(publicationOpIds.map(async (opId) => {
    const record = await input.operationRegistry.get(workspaceId, opId);
    if (!record || record.workspaceId !== workspaceId) {
      throw new Error(`AUTHORITY_CANONICAL_PUBLICATION_OPERATION_RECORD_MISSING:${opId}`);
    }
    return record;
  }));
  return {
    commitSha: publication.commitSha,
    previousHead: publication.previousCommit ?? publication.parentCommits[0]!,
    operations,
    ...(publication.physicalChanges && publication.physicalChanges.length > 0
      ? {
          observation: {
            opIds: publicationOpIds,
            commitSha: publication.commitSha,
            previousCommit: publication.previousCommit ?? publication.parentCommits[0]!,
            physicalChanges: publication.physicalChanges,
            pipelineGeneratedPaths: publication.pipelineGeneratedPaths ?? [],
            contentAddressedPaths: publication.contentAddressedPaths ?? []
          }
        }
      : {})
  };
}

export async function resolveAuthorityReplicaPublicationChange(input: {
  readonly changeLog: ReplicaChangeLog;
  readonly operations: ReadonlyArray<ReplicaPublicationOperation>;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly changedAt: string;
}): Promise<{
  readonly change: ReplicaChangeRecord | ReplicaChangeDraft;
  readonly existing: boolean;
}> {
  const known = await Promise.all(input.operations.map((operation) =>
    input.changeLog.getByOperation(operation.workspaceId, operation.opId)));
  const existing = known.find((change) => change !== undefined);
  if (existing && known.some((change) => !change || change.revision !== existing.revision)) {
    throw new Error("AUTHORITY_REPLICA_PUBLICATION_CHANGE_GROUP_SPLIT");
  }
  if (existing && (existing.commitSha !== input.commitSha
    || existing.previousCommit !== input.previousCommit
    || existing.operations.length !== input.operations.length
    || existing.operations.some((operation, index) => {
      const expected = input.operations[index];
      return !expected
        || operation.opId !== expected.opId
        || operation.semanticDigest !== expected.semanticDigest
        || operation.authorityIntegrity?.semanticMutationSetDigest
          !== expected.authorityIntegrity?.semanticMutationSetDigest;
    }))) {
    throw new Error("AUTHORITY_REPLICA_PUBLICATION_CHANGE_MISMATCH");
  }
  if (existing) return { change: existing, existing: true };
  const latest = await input.changeLog.latest(input.operations[0]!.workspaceId);
  return {
    change: createReplicaPublicationChange({
      revision: (latest?.revision ?? 0) + 1,
      operations: input.operations,
      commitSha: input.commitSha,
      previousCommit: input.previousCommit,
      changedAt: input.changedAt
    }),
    existing: false
  };
}
