// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const dispatch =
  "json_extract(event_json,'$.schema')='agent-runtime-event/v1' AND json_extract(event_json,'$.type')='runtime_dispatch_requested'";
const present = `CASE WHEN ${dispatch} AND EXISTS (SELECT 1 FROM runtime_session s WHERE s.runtime_session_id=json_extract(event_index.event_json,'$.payload.runtimeSessionId')) THEN 1 ELSE 0 END`;
// Unify the historical `idempotencyKey` spelling and the current `dispatchKey` in one indexed
// column. Non-dispatch rows carry '' so NULL remains the "not yet expanded" marker.
const dispatchKey = `CASE WHEN ${dispatch} THEN COALESCE(json_extract(event_json,'$.payload.dispatchKey'),json_extract(event_json,'$.payload.idempotencyKey'),'') ELSE '' END`;

/** Expand only. Historical rows are owned by the daemon writer maintenance queue. */
export function ensureRuntimeMemberIndex(db: DatabaseSync): void {
  if (!queryRows(db, "PRAGMA table_info(event_index)").some(({ name }) => name === "runtime_session_present"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN runtime_session_present INTEGER");
  if (!queryRows(db, "PRAGMA table_info(event_index)").some(({ name }) => name === "dispatch_key"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN dispatch_key TEXT");
  const ddl = [
    "CREATE INDEX IF NOT EXISTS event_index_runtime_member_pending ON event_index(workspace_revision) WHERE runtime_session_present IS NULL",
    "CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_key_pending ON event_index(workspace_revision) WHERE dispatch_key IS NULL",
    "CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_key ON event_index(dispatch_key, workspace_revision) WHERE " +
      dispatch,
    ...["INSERT", "UPDATE OF event_json"].map(
      (
        operation,
        n,
      ) => `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_presence_${n} AFTER ${operation} ON event_index BEGIN
      UPDATE event_index SET runtime_session_present=${present} WHERE op_id=NEW.op_id; END`,
    ),
    ...["INSERT", "UPDATE OF event_json"].map(
      (operation, n) => `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_key_${n} AFTER ${operation} ON event_index BEGIN
      UPDATE event_index SET dispatch_key=${dispatchKey} WHERE op_id=NEW.op_id; END`,
    ),
    `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_session_present AFTER INSERT ON runtime_session BEGIN
      UPDATE event_index SET runtime_session_present=1 WHERE ${dispatch} AND json_extract(event_json,'$.payload.runtimeSessionId')=NEW.runtime_session_id AND COALESCE(runtime_session_present,0)<>1;
    END`,
    `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_session_absent AFTER DELETE ON runtime_session BEGIN
      UPDATE event_index SET runtime_session_present=0 WHERE ${dispatch} AND json_extract(event_json,'$.payload.runtimeSessionId')=OLD.runtime_session_id AND runtime_session_present=1;
    END`,
    ...["agentId", "squadId"].flatMap((member) => [
      `CREATE INDEX IF NOT EXISTS event_index_runtime_member_${member}_time ON event_index(
        json_extract(event_json,'$.payload.${member}'), COALESCE(json_extract(event_json,'$.payload.startedAt'),json_extract(event_json,'$.occurredAt')) DESC, json_extract(event_json,'$.payload.dispatchId') DESC
      ) WHERE ${dispatch}`,
      `CREATE INDEX IF NOT EXISTS event_index_runtime_member_${member}_session ON event_index(
        json_extract(event_json,'$.payload.${member}'), json_extract(event_json,'$.payload.runtimeSessionId'), COALESCE(json_extract(event_json,'$.payload.startedAt'),json_extract(event_json,'$.occurredAt')) DESC, json_extract(event_json,'$.payload.dispatchId') DESC
      ) WHERE ${dispatch} AND runtime_session_present=1`,
    ]),
  ];
  for (const statement of ddl) runSql(db, statement);
  runSql(
    db,
    `CREATE TABLE IF NOT EXISTS runtime_read_index_progress (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, complete INTEGER NOT NULL
  )`,
  );
  runSql(
    db,
    `INSERT OR IGNORE INTO runtime_read_index_progress
    SELECT 1,0,CASE WHEN EXISTS(SELECT 1 FROM event_index WHERE runtime_session_present IS NULL LIMIT 1)
      OR EXISTS(SELECT 1 FROM event_index WHERE dispatch_key IS NULL LIMIT 1) THEN 0 ELSE 1 END`,
  );
}

/** One committed revision page; NULL partial indexes and the durable cursor skip completed history. */
export function backfillRuntimeReadIndexPage(db: DatabaseSync): { processed: number; done: boolean } {
  return transaction(db, () => {
    const progress = queryRows<{ revision: number; complete: number }>(
      db,
      "SELECT revision,complete FROM runtime_read_index_progress WHERE singleton=1",
    )[0]!;
    if (progress.complete) return { processed: 0, done: true };
    const rows = queryRows<{ workspace_revision: number }>(
      db,
      `SELECT workspace_revision FROM (
      SELECT workspace_revision FROM (SELECT workspace_revision FROM event_index
        WHERE runtime_session_present IS NULL AND workspace_revision>? ORDER BY workspace_revision LIMIT 64)
      UNION SELECT workspace_revision FROM (SELECT workspace_revision FROM event_index
        WHERE dispatch_key IS NULL AND workspace_revision>? ORDER BY workspace_revision LIMIT 64)
      ) ORDER BY workspace_revision LIMIT 64`,
      progress.revision,
      progress.revision,
    );
    for (const row of rows)
      runSql(
        db,
        `UPDATE event_index SET
        runtime_session_present=CASE WHEN runtime_session_present IS NULL THEN ${present} ELSE runtime_session_present END,
        dispatch_key=CASE WHEN dispatch_key IS NULL THEN ${dispatchKey} ELSE dispatch_key END
        WHERE workspace_revision=?`,
        row.workspace_revision,
      );
    if (rows.length === 0) runSql(db, "UPDATE runtime_read_index_progress SET complete=1 WHERE singleton=1");
    else
      runSql(
        db,
        "UPDATE runtime_read_index_progress SET revision=? WHERE singleton=1",
        rows.at(-1)!.workspace_revision,
      );
    return { processed: rows.length, done: rows.length === 0 };
  });
}

export function runtimeReadIndexReady(db: DatabaseSync): boolean {
  if (!queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_read_index_progress'").length)
    return false;
  return queryRows(db, "SELECT 1 FROM runtime_read_index_progress WHERE singleton=1 AND complete=1").length > 0;
}
