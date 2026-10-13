import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { ReplicationCommit } from "./replication-log.ts";
import type { CanonicalContentBlob } from "./task-event-store-types.ts";

/** A restored ledger has one local writer: the stream receiver, never a command executor. */
export function openReplicaStore(options: {
  readonly databasePath: string;
  readonly repoId: string;
  readonly generation?: number;
}) {
  const store = openSqliteEventStore(options);
  return {
    position: store.replicationPosition,
    apply: (commit: ReplicationCommit, blobs: readonly CanonicalContentBlob[]) =>
      store.applyReplicationCommit(commit, blobs),
    close: store.close,
  };
}
