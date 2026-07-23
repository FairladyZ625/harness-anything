import type { AuthorityOperationIntegrity } from "@harness-anything/kernel";
import type { ReplicaChangeDraft } from "./types.ts";

export interface ReplicaPublicationOperation {
  readonly workspaceId: string;
  readonly opId: string;
  readonly semanticDigest: string;
  readonly authorityIntegrity?: AuthorityOperationIntegrity;
}

export function createReplicaPublicationChange(input: {
  readonly revision: number;
  readonly operations: ReadonlyArray<ReplicaPublicationOperation>;
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly changedAt: string;
}): ReplicaChangeDraft {
  const primary = input.operations[0];
  if (!primary || input.operations.some((operation) => operation.workspaceId !== primary.workspaceId)) {
    throw new Error("AUTHORITY_REPLICA_PUBLICATION_OPERATION_GROUP_INVALID");
  }
  return {
    schema: "replica-change/v2",
    workspaceId: primary.workspaceId,
    revision: input.revision,
    opId: primary.opId,
    semanticDigest: primary.semanticDigest,
    operations: input.operations.map((operation) => ({
      opId: operation.opId,
      semanticDigest: operation.semanticDigest,
      ...(operation.authorityIntegrity ? { authorityIntegrity: operation.authorityIntegrity } : {})
    })),
    commitSha: input.commitSha,
    previousCommit: input.previousCommit,
    changedAt: input.changedAt,
    ...(primary.authorityIntegrity ? { authorityIntegrity: primary.authorityIntegrity } : {})
  };
}
