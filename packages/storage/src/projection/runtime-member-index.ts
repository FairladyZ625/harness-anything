// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const dispatch =
  "json_extract(event_json,'$.schema')='agent-runtime-event/v1' AND json_extract(event_json,'$.type')='runtime_dispatch_requested'";
const columns = [
  "dispatch_key",
  "runtime_session_id",
  "agentId",
  "squadId",
  "started_at",
  "dispatch_id",
  "runtime_session_present",
];
const materialize = `INSERT INTO runtime_dispatch_index(workspace_revision,${columns.join(",")})
  SELECT workspace_revision,
    COALESCE(json_extract(event_json,'$.payload.dispatchKey'),json_extract(event_json,'$.payload.idempotencyKey'),''),
    json_extract(event_json,'$.payload.runtimeSessionId'),json_extract(event_json,'$.payload.agentId'),
    json_extract(event_json,'$.payload.squadId'),COALESCE(json_extract(event_json,'$.payload.startedAt'),json_extract(event_json,'$.occurredAt')),
    json_extract(event_json,'$.payload.dispatchId'),
    EXISTS(SELECT 1 FROM runtime_session s WHERE s.runtime_session_id=json_extract(event_json,'$.payload.runtimeSessionId'))
  FROM event_index WHERE workspace_revision=? AND ${dispatch}
  ON CONFLICT(workspace_revision) DO UPDATE SET ${columns.map((column) => `${column}=excluded.${column}`).join(",")}`;

/** Indexes start empty: both key extraction and B-tree insertion belong to bounded writer pages. */
export function ensureRuntimeMemberIndex(db: DatabaseSync): void {
  transaction(db, () => {
    // Retire the previous derived-column writers. In particular its session trigger scans history.
    // Existing columns/indexes may remain for rollback; do not free large B-trees during attach.
    for (const name of [
      "runtime_dispatch_presence_0",
      "runtime_dispatch_presence_1",
      "runtime_dispatch_key_0",
      "runtime_dispatch_key_1",
      "runtime_dispatch_session_present",
      "runtime_dispatch_session_absent",
    ])
      runSql(db, `DROP TRIGGER IF EXISTS ${name}`);
    const existed =
      queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_dispatch_index'").length > 0;
    runSql(
      db,
      `CREATE TABLE IF NOT EXISTS runtime_dispatch_index (
    workspace_revision INTEGER PRIMARY KEY, dispatch_key TEXT NOT NULL, runtime_session_id TEXT,
    agentId TEXT, squadId TEXT, started_at TEXT, dispatch_id TEXT, runtime_session_present INTEGER NOT NULL
  )`,
    );
    const ddl = [
      "CREATE INDEX IF NOT EXISTS runtime_dispatch_key ON runtime_dispatch_index(dispatch_key,workspace_revision)",
      "CREATE INDEX IF NOT EXISTS runtime_dispatch_session ON runtime_dispatch_index(runtime_session_id)",
      ...["agentId", "squadId"].flatMap((member) => [
        `CREATE INDEX IF NOT EXISTS runtime_dispatch_${member}_time ON runtime_dispatch_index(${member},started_at DESC,dispatch_id DESC)`,
        `CREATE INDEX IF NOT EXISTS runtime_dispatch_${member}_session ON runtime_dispatch_index(${member},runtime_session_id,started_at DESC,dispatch_id DESC) WHERE runtime_session_present=1`,
      ]),
      ...["INSERT", "UPDATE OF event_json,workspace_revision"].map(
        (operation, n) =>
          `CREATE TRIGGER IF NOT EXISTS runtime_read_index_event_${n} AFTER ${operation} ON event_index BEGIN
        DELETE FROM runtime_dispatch_index WHERE workspace_revision IN (NEW.workspace_revision${n === 1 ? ",OLD.workspace_revision" : ""});
        ${materialize.replace("workspace_revision=?", "workspace_revision=NEW.workspace_revision")}; END`,
      ),
      `CREATE TRIGGER IF NOT EXISTS runtime_read_index_event_delete AFTER DELETE ON event_index BEGIN
      DELETE FROM runtime_dispatch_index WHERE workspace_revision=OLD.workspace_revision; END`,
      `CREATE TRIGGER IF NOT EXISTS runtime_read_index_session_present AFTER INSERT ON runtime_session BEGIN
      UPDATE runtime_dispatch_index SET runtime_session_present=1 WHERE runtime_session_id=NEW.runtime_session_id AND runtime_session_present<>1; END`,
      `CREATE TRIGGER IF NOT EXISTS runtime_read_index_session_absent AFTER DELETE ON runtime_session BEGIN
      UPDATE runtime_dispatch_index SET runtime_session_present=0 WHERE runtime_session_id=OLD.runtime_session_id AND runtime_session_present=1; END`,
    ];
    for (const statement of ddl) runSql(db, statement);
    runSql(
      db,
      `CREATE TABLE IF NOT EXISTS runtime_read_index_progress (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, complete INTEGER NOT NULL
  )`,
    );
    // A cache completed by the previous column-based implementation must fill the new empty index.
    // The table's existence makes this reset one-time and durable across repeated opens.
    if (!existed) runSql(db, "UPDATE runtime_read_index_progress SET revision=0,complete=0");
    runSql(
      db,
      `INSERT OR IGNORE INTO runtime_read_index_progress
    SELECT 1,0,CASE WHEN EXISTS(SELECT 1 FROM event_index LIMIT 1) THEN 0 ELSE 1 END`,
    );
  });
}

/** Seek the existing revision index; one transaction materializes at most 64 source rows. */
export function backfillRuntimeReadIndexPage(db: DatabaseSync): { processed: number; done: boolean } {
  return transaction(db, () => {
    const progress = queryRows<{ revision: number; complete: number }>(
      db,
      "SELECT revision,complete FROM runtime_read_index_progress WHERE singleton=1",
    )[0]!;
    if (progress.complete) return { processed: 0, done: true };
    const rows = queryRows<{ workspace_revision: number }>(
      db,
      "SELECT workspace_revision FROM event_index WHERE workspace_revision>? ORDER BY workspace_revision LIMIT 64",
      progress.revision,
    );
    for (const row of rows) runSql(db, materialize, row.workspace_revision);
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
  if (!queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_dispatch_index'").length)
    return false;
  return queryRows(db, "SELECT 1 FROM runtime_read_index_progress WHERE singleton=1 AND complete=1").length > 0;
}
