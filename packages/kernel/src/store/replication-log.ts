import type { SqliteCommandOutcome, SqliteEventRow, SqliteWriterFence } from "./sqlite-event-store.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";

export interface ReplicationPosition {
  readonly history: string;
  readonly sequence: number;
  readonly revision: number;
}

export interface ReplicationCommit {
  readonly position: ReplicationPosition;
  readonly events: readonly SqliteEventRow[];
  readonly outcome: SqliteCommandOutcome | null;
  readonly writer: SqliteWriterFence | null;
}

export type ReplicationQuery = (
  sql: string,
  values?: readonly (string | number | null)[],
) => Record<string, import("node:sqlite").SQLOutputValue>[];

export const REPLICATION_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS replication_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    history TEXT NOT NULL, sequence INTEGER NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO replication_state VALUES(1, lower(hex(randomblob(16))), 0);
  CREATE TABLE IF NOT EXISTS replication_log (
    sequence INTEGER PRIMARY KEY, revision INTEGER NOT NULL,
    outcome_op_id TEXT, writer_json TEXT
  ) STRICT;`;

export function readReplicationPosition(query: ReplicationQuery): ReplicationPosition {
  const row = query("SELECT history,sequence,revision FROM replication_state JOIN ledger_meta USING(singleton)")[0]!;
  return { history: String(row.history), sequence: Number(row.sequence), revision: Number(row.revision) };
}

/** Called in the accepting transaction; event bytes and outcomes remain in their original tables. */
export function recordReplicationCommit(
  query: ReplicationQuery,
  outcomeOpId: string | null,
  writer: SqliteWriterFence | null,
): ReplicationPosition {
  query("UPDATE replication_state SET sequence=sequence+1 WHERE singleton=1");
  const position = readReplicationPosition(query);
  query("INSERT INTO replication_log VALUES(?,?,?,?)", [
    position.sequence,
    position.revision,
    outcomeOpId,
    writer === null ? null : JSON.stringify(writer),
  ]);
  return position;
}

export function readReplicationCommits(
  query: ReplicationQuery,
  after: ReplicationPosition,
  limit: number,
  readOutcome: (opId: string) => SqliteCommandOutcome | null,
  readEvents: (afterRevision: number, limit: number) => readonly SqliteEventRow[],
): { readonly commits: readonly ReplicationCommit[]; readonly done: boolean; readonly head: ReplicationPosition } {
  const head = readReplicationPosition(query);
  const anchor = query("SELECT revision FROM replication_log WHERE sequence=?", [after.sequence])[0];
  if (
    after.history !== head.history ||
    !anchor ||
    after.revision !== Number(anchor.revision) ||
    after.sequence > head.sequence
  )
    throw new TaskEventStoreError("revision_conflict", "replication_snapshot_required");
  const commits = query("SELECT * FROM replication_log WHERE sequence>? ORDER BY sequence LIMIT ?", [
    after.sequence,
    limit,
  ]).map((row) => {
    const outcome = row.outcome_op_id === null ? null : readOutcome(String(row.outcome_op_id));
    return {
      position: { history: head.history, sequence: Number(row.sequence), revision: Number(row.revision) },
      outcome,
      events:
        outcome?.firstRevision == null
          ? []
          : readEvents(outcome.firstRevision - 1, outcome.lastRevision! - outcome.firstRevision + 1),
      writer: row.writer_json === null ? null : (JSON.parse(String(row.writer_json)) as SqliteWriterFence),
    };
  });
  return { commits, done: (commits.at(-1)?.position.sequence ?? after.sequence) === head.sequence, head };
}
