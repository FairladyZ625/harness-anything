// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const dispatch =
  "json_extract(event_json,'$.schema')='agent-runtime-event/v1' AND json_extract(event_json,'$.type')='runtime_dispatch_requested'";
const present = `CASE WHEN ${dispatch} AND EXISTS(SELECT 1 FROM runtime_session s WHERE s.runtime_session_id=json_extract(event_json,'$.payload.runtimeSessionId')) THEN 1 ELSE 0 END`;
const legacyKey = `CASE WHEN ${dispatch} THEN COALESCE(json_extract(event_json,'$.payload.dispatchKey'),json_extract(event_json,'$.payload.idempotencyKey'),'') ELSE '' END`;
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
    // Empty databases can build immediately; historical leases use the same background turn.
    if (leaseIntervalIndexMissing(db) && !queryRows(db, "SELECT 1 FROM lease_interval LIMIT 1").length)
      runSql(db, leaseIntervalIndexDdl);
    const legacy = expandLegacyRuntimeIndex(db);
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
      `CREATE TRIGGER IF NOT EXISTS runtime_read_index_session_present AFTER INSERT ON runtime_session BEGIN
      UPDATE runtime_dispatch_index SET runtime_session_present=1 WHERE runtime_session_id=NEW.runtime_session_id AND runtime_session_present<>1; END`,
      `CREATE TRIGGER IF NOT EXISTS runtime_read_index_session_absent AFTER DELETE ON runtime_session BEGIN
      UPDATE runtime_dispatch_index SET runtime_session_present=0 WHERE runtime_session_id=OLD.runtime_session_id AND runtime_session_present=1; END`,
    ];
    for (const statement of ddl) runSql(db, statement);
    createRuntimeReadEventTriggers(db);
    runSql(
      db,
      `CREATE TABLE IF NOT EXISTS runtime_read_index_progress (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, complete INTEGER NOT NULL
  )`,
    );
    // A cache completed by the previous column-based implementation must fill the new empty index.
    // The table's existence makes this reset one-time and durable across repeated opens.
    if (!existed || legacy.repairRows) runSql(db, "UPDATE runtime_read_index_progress SET revision=0,complete=0");
    else if (legacy.missingIndexes) runSql(db, "UPDATE runtime_read_index_progress SET complete=0");
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
    if (leaseIntervalIndexMissing(db)) {
      runSql(db, leaseIntervalIndexDdl);
      return { processed: 0, done: false };
    }
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
    for (const row of rows) {
      runSql(db, materialize, row.workspace_revision);
      runSql(
        db,
        `UPDATE event_index SET runtime_session_present=${present},dispatch_key=${legacyKey}
        WHERE workspace_revision=? AND (runtime_session_present IS NOT (${present}) OR dispatch_key IS NOT (${legacyKey}))`,
        row.workspace_revision,
      );
    }
    if (rows.length === 0) {
      const missing = missingLegacyIndex(db);
      if (missing) {
        // SQLite cannot page a B-tree build. One original-table index per background
        // writer turn; never rebuild or rename the table to create an index.
        runSql(db, `CREATE INDEX IF NOT EXISTS ${missing[0]} ON event_index${missing[1]}`);
        return { processed: 0, done: false };
      }
      runSql(db, "UPDATE runtime_read_index_progress SET complete=1 WHERE singleton=1");
    } else
      runSql(
        db,
        "UPDATE runtime_read_index_progress SET revision=? WHERE singleton=1",
        rows.at(-1)!.workspace_revision,
      );
    return { processed: rows.length, done: rows.length === 0 };
  });
}

const leaseIntervalIndexDdl =
  "CREATE INDEX IF NOT EXISTS lease_interval_task_revision ON lease_interval(task_id,acquired_revision)";

function leaseIntervalIndexMissing(db: DatabaseSync): boolean {
  return (
    queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='lease_interval'").length > 0 &&
    !queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='index' AND name='lease_interval_task_revision'").length
  );
}

export function leaseIntervalIndexProgress(db: DatabaseSync): string | null {
  return leaseIntervalIndexMissing(db) ? "index=lease_interval_task_revision" : null;
}

export function runtimeReadIndexReady(db: DatabaseSync): boolean {
  if (!queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_dispatch_index'").length)
    return false;
  return queryRows(db, "SELECT 1 FROM runtime_read_index_progress WHERE singleton=1 AND complete=1").length > 0;
}

function createRuntimeReadEventTriggers(db: DatabaseSync): void {
  const ddl = [
    ...["INSERT", "UPDATE OF event_json,workspace_revision"].map(
      (operation, n) =>
        `CREATE TRIGGER IF NOT EXISTS runtime_read_index_event_${n} AFTER ${operation} ON event_index BEGIN
        DELETE FROM runtime_dispatch_index WHERE workspace_revision IN (NEW.workspace_revision${n === 1 ? ",OLD.workspace_revision" : ""});
        ${materialize.replace("workspace_revision=?", "workspace_revision=NEW.workspace_revision")}; END`,
    ),
    `CREATE TRIGGER IF NOT EXISTS runtime_read_index_event_delete AFTER DELETE ON event_index BEGIN
      DELETE FROM runtime_dispatch_index WHERE workspace_revision=OLD.workspace_revision; END`,
  ];
  for (const statement of ddl) runSql(db, statement);
}

// Current + previous physical reader window. Remove legacy columns/trees/triggers and this
// compatibility maintenance after every deployed repository is complete, no later than 2026-12-05.
const legacyIndexes: readonly [string, string][] = [
  ["event_index_runtime_member_pending", "(workspace_revision) WHERE runtime_session_present IS NULL"],
  ["event_index_runtime_dispatch_key_pending", "(workspace_revision) WHERE dispatch_key IS NULL"],
  ["event_index_runtime_dispatch_key", `(dispatch_key,workspace_revision) WHERE ${dispatch}`],
  ...["agentId", "squadId"].flatMap((member): [string, string][] => [
    [
      `event_index_runtime_member_${member}_time`,
      `(json_extract(event_json,'$.payload.${member}'),COALESCE(json_extract(event_json,'$.payload.startedAt'),json_extract(event_json,'$.occurredAt')) DESC,json_extract(event_json,'$.payload.dispatchId') DESC) WHERE ${dispatch}`,
    ],
    [
      `event_index_runtime_member_${member}_session`,
      `(json_extract(event_json,'$.payload.${member}'),json_extract(event_json,'$.payload.runtimeSessionId'),COALESCE(json_extract(event_json,'$.payload.startedAt'),json_extract(event_json,'$.occurredAt')) DESC,json_extract(event_json,'$.payload.dispatchId') DESC) WHERE ${dispatch} AND runtime_session_present=1`,
    ],
  ]),
];
const legacyTriggerNames = [
  "runtime_dispatch_presence_0",
  "runtime_dispatch_presence_1",
  "runtime_dispatch_key_0",
  "runtime_dispatch_key_1",
  "runtime_dispatch_session_present",
  "runtime_dispatch_session_absent",
];
function installLegacyRuntimeTriggers(db: DatabaseSync): void {
  for (const name of legacyTriggerNames) runSql(db, `DROP TRIGGER IF EXISTS ${name}`);
  for (const [n, operation] of ["INSERT", "UPDATE OF event_json"].entries()) {
    runSql(
      db,
      `CREATE TRIGGER runtime_dispatch_presence_${n} AFTER ${operation} ON event_index BEGIN
      UPDATE event_index SET runtime_session_present=${present} WHERE op_id=NEW.op_id; END`,
    );
    runSql(
      db,
      `CREATE TRIGGER runtime_dispatch_key_${n} AFTER ${operation} ON event_index BEGIN
      UPDATE event_index SET dispatch_key=${legacyKey} WHERE op_id=NEW.op_id; END`,
    );
  }
  for (const [action, operation, ref, value] of [
    ["present", "INSERT", "NEW", 1],
    ["absent", "DELETE", "OLD", 0],
  ] as const)
    runSql(
      db,
      `CREATE TRIGGER runtime_dispatch_session_${action} AFTER ${operation} ON runtime_session BEGIN
    UPDATE event_index SET runtime_session_present=${value}
      WHERE ${dispatch} AND json_extract(event_json,'$.payload.runtimeSessionId')=${ref}.runtime_session_id
        AND runtime_session_present IS NOT ${value}; END`,
    );
}

/** Expand fields and triggers; only empty tables may build physical indexes at attach. */
function expandLegacyRuntimeIndex(db: DatabaseSync): { repairRows: boolean; missingIndexes: boolean } {
  const names = new Set(queryRows<{ name: string }>(db, "PRAGMA table_info(event_index)").map((row) => row.name));
  if (!names.has("runtime_session_present"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN runtime_session_present INTEGER");
  if (!names.has("dispatch_key")) runSql(db, "ALTER TABLE event_index ADD COLUMN dispatch_key TEXT");
  const writers = new Set(
    queryRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='trigger'").map((row) => row.name),
  );
  const populated = queryRows(db, "SELECT 1 FROM event_index LIMIT 1").length > 0;
  if (!populated)
    for (const [name, expression] of legacyIndexes)
      runSql(db, `CREATE INDEX IF NOT EXISTS ${name} ON event_index${expression}`);
  installLegacyRuntimeTriggers(db);
  return {
    repairRows:
      populated &&
      (!names.has("runtime_session_present") ||
        !names.has("dispatch_key") ||
        legacyTriggerNames.some((name) => !writers.has(name))),
    missingIndexes: populated && missingLegacyIndex(db) !== undefined,
  };
}

function missingLegacyIndex(db: DatabaseSync): (typeof legacyIndexes)[number] | undefined {
  const names = new Set(
    queryRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='event_index'").map(
      (row) => row.name,
    ),
  );
  return legacyIndexes.find(([name]) => !names.has(name));
}

export function assertRuntimeReadIndexReady(db: DatabaseSync): void {
  if (runtimeReadIndexReady(db)) return;
  const progress = queryRows(db, "SELECT 1 FROM sqlite_master WHERE name='runtime_read_index_progress'").length
    ? queryRows(db, "SELECT revision FROM runtime_read_index_progress WHERE singleton=1")[0]
    : undefined;
  throw Object.assign(new Error(`索引迁移中; progress revision=${progress?.revision ?? 0}`), {
    code: "projection_pending",
  });
}

/** Base backups complete the same migration on their private copy before an old edge reads it. */
export function legacyRuntimeIndexReady(db: DatabaseSync): boolean {
  return (
    missingLegacyIndex(db) === undefined &&
    queryRows(db, "SELECT 1 FROM event_index WHERE runtime_session_present IS NULL LIMIT 1").length === 0 &&
    queryRows(db, "SELECT 1 FROM event_index WHERE dispatch_key IS NULL LIMIT 1").length === 0
  );
}
