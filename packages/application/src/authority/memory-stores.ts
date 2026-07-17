import type {
  AuthorityStoredOperationRecord,
  AuthorityOperationRegistry,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "./types.ts";

export function createInMemoryAuthorityOperationRegistry(): AuthorityOperationRegistry {
  const records = new Map<string, AuthorityStoredOperationRecord>();
  return {
    get: async (workspaceId, opId) => cloneOptional(records.get(key(workspaceId, opId))),
    put: async (record) => {
      const recordKey = key(record.workspaceId, record.opId);
      records.set(recordKey, structuredClone({ ...records.get(recordKey), ...record }));
    },
    list: async (workspaceId) => [...records.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => left.opId.localeCompare(right.opId))
      .map((record) => structuredClone(record))
  };
}

export function createInMemoryReplicaChangeLog(): ReplicaChangeLog {
  const records: ReplicaChangeRecord[] = [];
  return {
    append: async (record) => {
      const duplicate = records.find((candidate) => candidate.workspaceId === record.workspaceId && candidate.opId === record.opId);
      if (duplicate) {
        if (duplicate.semanticDigest !== record.semanticDigest || duplicate.commitSha !== record.commitSha) {
          throw new Error(`ReplicaChangeLog opId reuse: ${record.opId}`);
        }
        return;
      }
      const latest = records.filter((candidate) => candidate.workspaceId === record.workspaceId).at(-1);
      if (record.revision !== (latest?.revision ?? 0) + 1) {
        throw new Error(`ReplicaChangeLog revision gap: expected ${(latest?.revision ?? 0) + 1}, received ${record.revision}`);
      }
      const expectedPreviousCommit = latest?.commitSha === record.commitSha
        ? latest.previousCommit
        : latest?.commitSha;
      if (latest && record.previousCommit !== expectedPreviousCommit) {
        throw new Error(`ReplicaChangeLog parent mismatch at revision ${record.revision}`);
      }
      records.push(structuredClone(record));
    },
    latest: async (workspaceId) => cloneOptional(records.filter((record) => record.workspaceId === workspaceId).at(-1)),
    getByOperation: async (workspaceId, opId) => cloneOptional(records.find((record) => record.workspaceId === workspaceId && record.opId === opId)),
    changesAfter: async (workspaceId, revision) => records
      .filter((record) => record.workspaceId === workspaceId && record.revision > revision)
      .map((record) => structuredClone(record))
  };
}

function key(workspaceId: string, opId: string): string {
  return `${workspaceId}\0${opId}`;
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
