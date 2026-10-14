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
    apply: (commit: ReplicationCommit, blobs: readonly CanonicalContentBlob[]) => {
      const applied = store.applyReplicationCommit(commit, blobs);
      // A replica never serves the log; once a commit is durable only its own position row anchors the
      // stream, so older rows are recycled here (a standby recycling WAL after its restartpoint).
      store.pruneReplicationLog(applied.sequence);
      return applied;
    },
    close: store.close,
  };
}
