import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { ReplicationCommit } from "./replication-log.ts";
import type { CanonicalContentBlob } from "@harness-anything/kernel/internal/ports/task-event-store.ts";

/**
 * Default bounded replication_log window retained on replicas so planned Switchover (dec_AAEC26DBB6F23BDF80876ABB2C CH2)
 * can promote a replica in place without rotating history while letting lagging edges resume incrementally.
 * Amortized O(1) maintenance per commit (bounded row count, never grows with total repository history).
 */
export const DEFAULT_REPLICA_LOG_WINDOW_COMMITS = 1024;

function normalizeRetentionWindow(windowCommits: number | undefined): number {
  if (windowCommits === undefined) return DEFAULT_REPLICA_LOG_WINDOW_COMMITS;
  if (!Number.isSafeInteger(windowCommits) || windowCommits < 0)
    throw new Error("Replica replication_log retentionWindowCommits must be a nonnegative safe integer.");
  return windowCommits;
}

/** A restored ledger has one local writer: the stream receiver, never a command executor. */
export function openReplicaStore(options: {
  readonly databasePath: string;
  readonly repoId: string;
  readonly generation?: number;
  readonly retentionWindowCommits?: number;
}) {
  const retentionWindowCommits = normalizeRetentionWindow(options.retentionWindowCommits),
    store = openSqliteEventStore(options);
  const pruneToWindow = (headSequence: number): void => {
    const keepFrom = Math.max(0, headSequence - retentionWindowCommits);
    store.pruneReplicationLog(keepFrom);
  };
  // A backup may already be at the head, so recycle rows older than the bounded window immediately.
  pruneToWindow(store.replicationPosition().sequence);
  return {
    position: store.replicationPosition,
    apply: (
      commit: ReplicationCommit<Iterable<import("./sqlite-event-store-types.ts").SqliteEventRow>>,
      blobs: readonly CanonicalContentBlob[],
    ) => {
      const applied = store.applyReplicationCommit(commit, blobs);
      pruneToWindow(applied.sequence);
      return applied;
    },
    close: store.close,
  };
}
