import type {
  AuthorityStoredOperationRecord,
  AuthorityOperationRegistry,
  ReplicaChangeDraft,
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
  const listeners = new Map<string, Set<(record: ReplicaChangeRecord) => void>>();
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
      const normalized = normalizeChange(record);
      records.push(normalized);
      for (const listener of listeners.get(record.workspaceId) ?? []) listener(structuredClone(normalized));
    },
    latest: async (workspaceId) => cloneOptional(records.filter((record) => record.workspaceId === workspaceId).at(-1)),
    getByOperation: async (workspaceId, opId) => cloneOptional(records.find((record) => record.workspaceId === workspaceId && record.opId === opId)),
    changesAfter: async (workspaceId, revision) => records
      .filter((record) => record.workspaceId === workspaceId && record.revision > revision)
      .map((record) => structuredClone(record)),
    subscribe: (workspaceId, listener) => {
      const workspaceListeners = listeners.get(workspaceId) ?? new Set();
      workspaceListeners.add(listener);
      listeners.set(workspaceId, workspaceListeners);
      return () => {
        workspaceListeners.delete(listener);
        if (workspaceListeners.size === 0) listeners.delete(workspaceId);
      };
    }
  };
}

function normalizeChange(record: ReplicaChangeDraft): ReplicaChangeRecord {
  return structuredClone({
    ...record,
    manifest: record.manifest ?? {
      digest: `sha256:${record.semanticDigest}`,
      entryCount: record.paths?.filter((entry) => !entry.tombstone).length ?? 0
    },
    paths: record.paths ?? []
  });
}

function key(workspaceId: string, opId: string): string {
  return `${workspaceId}\0${opId}`;
}

function cloneOptional<Value>(value: Value | undefined): Value | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
