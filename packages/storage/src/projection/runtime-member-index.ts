// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const dispatch =
  "json_extract(event_json,'$.schema')='agent-runtime-event/v1' AND json_extract(event_json,'$.type')='runtime_dispatch_requested'";
const present = `CASE WHEN ${dispatch} AND EXISTS (SELECT 1 FROM runtime_session s WHERE s.runtime_session_id=json_extract(event_index.event_json,'$.payload.runtimeSessionId')) THEN 1 ELSE 0 END`;

/** Additive, old-writer-compatible cache expansion; commit every 64 pending rows. */
export function ensureRuntimeMemberIndex(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
): void {
  if (!queryRows(db, "PRAGMA table_info(event_index)").some(({ name }) => name === "runtime_session_present"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN runtime_session_present INTEGER");
  const ddl = [
    "CREATE INDEX IF NOT EXISTS event_index_runtime_member_pending ON event_index(workspace_revision) WHERE runtime_session_present IS NULL",
    ...["INSERT", "UPDATE OF event_json"].map(
      (
        operation,
        n,
      ) => `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_presence_${n} AFTER ${operation} ON event_index BEGIN
      UPDATE event_index SET runtime_session_present=${present} WHERE op_id=NEW.op_id; END`,
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
  let applied = 0,
    total = 0;
  for (;;) {
    const rows = queryRows<{ workspace_revision: number }>(
      db,
      "SELECT workspace_revision FROM event_index WHERE runtime_session_present IS NULL ORDER BY workspace_revision LIMIT 64",
    );
    if (rows.length === 0) return;
    if (total === 0)
      total = Number(
        queryRows(db, "SELECT count(*) AS count FROM event_index WHERE runtime_session_present IS NULL")[0]!.count,
      );
    transaction(db, () => {
      for (const row of rows)
        runSql(
          db,
          `UPDATE event_index SET runtime_session_present=${present} WHERE workspace_revision=?`,
          row.workspace_revision,
        );
    });
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

/** Read-only generations cannot silently answer from an incomplete expansion. */
export function assertRuntimeMemberIndexReady(db: DatabaseSync): void {
  if (
    queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='index' AND name='event_index_runtime_member_pending'")
      .length === 0 ||
    queryRows(db, "SELECT 1 FROM event_index WHERE runtime_session_present IS NULL LIMIT 1").length > 0
  )
    throw Object.assign(new Error("Runtime member index catch-up is pending"), { code: "projection_pending" });
}
