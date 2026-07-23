import {
  type AuthorityOperationRegistry,
  type AuthorityStoredOperationRecord,
  type ReplicaChangeLog,
  type ReplicaChangeRecord
} from "@harness-anything/application";
import type { SemanticMutationSetV2 } from "@harness-anything/kernel";
import {
  assertPublicationMatchesMutationSet,
  type CanonicalPublicationEvidence
} from "./publication-evidence.ts";

export async function recoverReplicaPublicationGroup(input: {
  readonly record: AuthorityStoredOperationRecord;
  readonly operationRegistry: AuthorityOperationRegistry;
  readonly replicaChangeLog: ReplicaChangeLog;
  readonly evidence: CanonicalPublicationEvidence;
  readonly beforeAppend?: () => Promise<void>;
}): Promise<ReplicaChangeRecord> {
  const opIds = input.evidence.opIds ?? [input.record.opId];
  if (opIds.length === 0
    || !opIds.includes(input.record.opId)
    || new Set(opIds).size !== opIds.length) {
    throw new Error("AUTHORITY_V2_RECOVERY_OPERATION_GROUP_INVALID");
  }
  const records = await Promise.all(opIds.map(async (opId) => {
    const record = await input.operationRegistry.get(input.record.workspaceId, opId);
    if (!record
      || record.workspaceId !== input.record.workspaceId
      || !record.authorityIntegrity
      || (record.commitSha && record.commitSha !== input.evidence.commitSha)) {
      throw new Error(`AUTHORITY_V2_RECOVERY_OPERATION_GROUP_INCOMPLETE:${opId}`);
    }
    return record;
  }));
  const mutationSet = aggregateMutationSets(records);
  assertPublicationMatchesMutationSet(input.evidence, mutationSet);

  const known = await Promise.all(opIds.map((opId) =>
    input.replicaChangeLog.getByOperation(input.record.workspaceId, opId)));
  const existing = known.find((change) => change !== undefined);
  if (existing) {
    if (known.some((change) => !change || change.revision !== existing.revision)) {
      throw new Error("AUTHORITY_V2_RECOVERY_CHANGE_GROUP_SPLIT");
    }
    assertChangeMatchesPublication(existing, records, input.evidence);
    return existing;
  }

  const latest = await input.replicaChangeLog.latest(input.record.workspaceId);
  await input.beforeAppend?.();
  const draft = publicationChangeDraft(
    records,
    (latest?.revision ?? 0) + 1,
    input.evidence
  );
  await input.replicaChangeLog.append(draft);
  const appended = await input.replicaChangeLog.getByOperation(input.record.workspaceId, input.record.opId);
  if (!appended) throw new Error("AUTHORITY_V2_RECOVERY_CHANGE_APPEND_MISSING");
  assertChangeMatchesPublication(appended, records, input.evidence);
  return appended;
}

function publicationChangeDraft(
  records: ReadonlyArray<AuthorityStoredOperationRecord>,
  revision: number,
  evidence: CanonicalPublicationEvidence
): ReplicaChangeDraft {
  const primary = records[0];
  if (!primary) throw new Error("AUTHORITY_V2_RECOVERY_OPERATION_GROUP_INVALID");
  return {
    schema: "replica-change/v2",
    workspaceId: primary.workspaceId,
    revision,
    opId: primary.opId,
    semanticDigest: primary.semanticDigest,
    operations: records.map((record) => ({
      opId: record.opId,
      semanticDigest: record.semanticDigest,
      ...(record.authorityIntegrity ? { authorityIntegrity: record.authorityIntegrity } : {})
    })),
    commitSha: evidence.commitSha,
    previousCommit: evidence.previousCommit,
    changedAt: new Date().toISOString(),
    ...(primary.authorityIntegrity ? { authorityIntegrity: primary.authorityIntegrity } : {})
  };
}

type ReplicaChangeDraft = Parameters<ReplicaChangeLog["append"]>[0];

function aggregateMutationSets(
  records: ReadonlyArray<AuthorityStoredOperationRecord>
): SemanticMutationSetV2 {
  const registryVersion = records[0]?.authorityIntegrity?.canonicalMutationSet.registryVersion;
  if (registryVersion !== 1 || records.some((record) =>
    record.authorityIntegrity?.canonicalMutationSet.registryVersion !== registryVersion)) {
    throw new Error("AUTHORITY_V2_RECOVERY_MUTATION_REGISTRY_MISMATCH");
  }
  return {
    registryVersion,
    mutations: records.flatMap((record) =>
      record.authorityIntegrity!.canonicalMutationSet.mutations)
  };
}

function assertChangeMatchesPublication(
  change: ReplicaChangeRecord,
  records: ReadonlyArray<AuthorityStoredOperationRecord>,
  evidence: CanonicalPublicationEvidence
): void {
  if (change.commitSha !== evidence.commitSha
    || change.previousCommit !== evidence.previousCommit
    || change.operations.length !== records.length
    || change.operations.some((operation, index) => {
      const record = records[index];
      return !record
        || operation.opId !== record.opId
        || operation.semanticDigest !== record.semanticDigest
        || operation.authorityIntegrity?.semanticMutationSetDigest
          !== record.authorityIntegrity?.semanticMutationSetDigest;
    })) {
    throw new Error("AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH");
  }
}
