import type { ReplicationSlots } from "../fleet-replication-slot.ts";
import { createPgTaskQueryReader } from "../pg/pg-task-query-reader.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import type { PostgresStorageBackendConfig } from "../storage-backend.ts";

export function openPgReplicationSlots(repoId: string, storage: PostgresStorageBackendConfig): ReplicationSlots {
  const reader = createPgTaskQueryReader({
      connectionString: storage.connectionString,
      scope: resolvePostgresEventStoreScope(storage.scope),
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
