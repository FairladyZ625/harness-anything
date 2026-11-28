import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const dispatch = "event_schema='agent-runtime-event/v1' AND event_type='runtime_dispatch_requested'";
const present = `CASE WHEN ${dispatch} AND EXISTS (SELECT 1 FROM runtime_session s WHERE s.runtime_session_id=event_index.runtime_session_id) THEN 1 ELSE 0 END`;

/** Ensure derived columns exist before bulk replay writes them directly without triggers. */
export function ensureRuntimeMemberIndexColumns(db: DatabaseSync): void {
  const columns = queryRows(db, "PRAGMA table_info(event_index)");
  if (!columns.some(({ name }) => name === "runtime_session_present"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN runtime_session_present INTEGER");
  if (!columns.some(({ name }) => name === "dispatch_key"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN dispatch_key TEXT");
}

/** Pure-scalar member & dispatch-key indexes and presence triggers (zero json_extract on event_json). */
export function installRuntimeMemberIndexDdl(db: DatabaseSync): void {
  ensureRuntimeMemberIndexColumns(db);
  const ddl = [
    "DROP TRIGGER IF EXISTS runtime_dispatch_presence_1",
    "DROP TRIGGER IF EXISTS runtime_dispatch_key_0",
    "DROP TRIGGER IF EXISTS runtime_dispatch_key_1",
    "CREATE INDEX IF NOT EXISTS event_index_runtime_member_pending ON event_index(workspace_revision) WHERE runtime_session_present IS NULL",
    "CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_key_pending ON event_index(workspace_revision) WHERE dispatch_key IS NULL",
    "CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_key ON event_index(dispatch_key, workspace_revision) WHERE " +
      dispatch,
    `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_presence_0 AFTER INSERT ON event_index
      WHEN NEW.runtime_session_present IS NULL
      BEGIN
        UPDATE event_index SET runtime_session_present=${present} WHERE op_id=NEW.op_id;
      END`,
    `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_session_present AFTER INSERT ON runtime_session BEGIN
      UPDATE event_index SET runtime_session_present=1 WHERE ${dispatch} AND runtime_session_id=NEW.runtime_session_id AND COALESCE(runtime_session_present,0)<>1;
    END`,
    `CREATE TRIGGER IF NOT EXISTS runtime_dispatch_session_absent AFTER DELETE ON runtime_session BEGIN
      UPDATE event_index SET runtime_session_present=0 WHERE ${dispatch} AND runtime_session_id=OLD.runtime_session_id AND runtime_session_present=1;
    END`,
    ...[
      ["agentId", "agent_id"],
      ["squadId", "squad_id"],
    ].flatMap(([member, column]) => [
      `CREATE INDEX IF NOT EXISTS event_index_runtime_member_${member}_time ON event_index(
        ${column}, dispatch_activity_at DESC, dispatch_id DESC
      ) WHERE ${dispatch}`,
      `CREATE INDEX IF NOT EXISTS event_index_runtime_member_${member}_session ON event_index(
        ${column}, runtime_session_id, dispatch_activity_at DESC, dispatch_id DESC
      ) WHERE ${dispatch} AND runtime_session_present=1`,
    ]),
  ];
  for (const statement of ddl) runSql(db, statement);
}

/** Additive, old-writer-compatible cache expansion; commit every 64 pending rows. */
export function ensureRuntimeMemberIndex(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
): void {
  installRuntimeMemberIndexDdl(db);
  let applied = 0,
    total = 0;
  // Query each partial pending index separately and union the bounded heads: an OR predicate
  // forces SQLite to scan every event_index row on every cold projection open.
  const pendingPageSql = `SELECT workspace_revision FROM (
      SELECT workspace_revision FROM event_index WHERE runtime_session_present IS NULL ORDER BY workspace_revision LIMIT 64
    )
    UNION
    SELECT workspace_revision FROM (
      SELECT workspace_revision FROM event_index WHERE dispatch_key IS NULL ORDER BY workspace_revision LIMIT 64
    )
    ORDER BY workspace_revision LIMIT 64`;
  const pendingCountSql = `SELECT count(*) AS count FROM (
      SELECT workspace_revision FROM event_index WHERE runtime_session_present IS NULL
      UNION
      SELECT workspace_revision FROM event_index WHERE dispatch_key IS NULL
    )`;
  for (;;) {
    const rows = queryRows<{ workspace_revision: number }>(db, pendingPageSql);
    if (rows.length === 0) return;
    if (total === 0) total = Number(queryRows(db, pendingCountSql)[0]!.count);
    transaction(db, () => {
      for (const row of rows)
        runSql(
          db,
          `UPDATE event_index SET
            runtime_session_present=CASE WHEN runtime_session_present IS NULL THEN ${present} ELSE runtime_session_present END,
            dispatch_key=COALESCE(dispatch_key, '')
          WHERE workspace_revision=?`,
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

/** The dispatch-key read must not answer before the historical-key expansion is complete. */
export function assertRuntimeDispatchKeyIndexReady(db: DatabaseSync): void {
  if (
    queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='index' AND name='event_index_runtime_dispatch_key_pending'")
      .length === 0 ||
    queryRows(db, "SELECT 1 FROM event_index WHERE dispatch_key IS NULL LIMIT 1").length > 0
  )
    throw Object.assign(new Error("Runtime dispatch key index catch-up is pending"), { code: "projection_pending" });
}
