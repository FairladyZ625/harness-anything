import type { ReplicationSlots } from "../fleet-replication-slot.ts";
import { createSqlTaskQueryReader } from "../pg/sql-task-query-reader.ts";
import type { PostgresStorageBackendConfig, PGliteStorageBackendConfig } from "../storage-backend.ts";

export function openPgReplicationSlots(
  repoId: string,
  storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig,
): ReplicationSlots {
  const reader = createSqlTaskQueryReader({
      storage,
      requireRuntimeRole: true,
      repoId,
    }),
    call = <T>(method: string, ...args: unknown[]): T => reader.replication("slots", { method, args }) as T;
  return {
    claim: (key, history) => call("claim", key, history),
    current: (lease) => call("current", lease),
    cursor: (key) => call("cursor", key),
    acknowledge: (lease, ack, sent) => call("acknowledge", lease, ack, sent),
    minimumAck: (repo, history) => call("minimumAck", repo, history),
    removeNode: (nodeId) => call("removeNode", nodeId),
    invalidateOffline: (repo) => call("invalidateOffline", repo),
    list: () => call("list"),
    close: reader.close,
  };
}
