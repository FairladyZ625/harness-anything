// @write-boundary-exemption rebuildable-projection
import type { DatabaseSync } from "node:sqlite";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const dispatch =
  "json_extract(event_json,'$.schema')='agent-runtime-event/v1' AND json_extract(event_json,'$.type')='runtime_dispatch_requested'";
const present = `CASE WHEN ${dispatch} AND EXISTS(SELECT 1 FROM runtime_session s WHERE s.runtime_session_id=json_extract(event_json,'$.payload.runtimeSessionId')) THEN 1 ELSE 0 END`;
const legacyKey = `CASE WHEN ${dispatch} THEN COALESCE(json_extract(event_json,'$.payload.dispatchKey'),json_extract(event_json,'$.payload.idempotencyKey'),'') ELSE '' END`;
const shadow = "runtime_event_index_compat";
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
    const legacyCreated = expandLegacyRuntimeIndex(db);
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
    if (!existed || legacyCreated) runSql(db, "UPDATE runtime_read_index_progress SET revision=0,complete=0");
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
    const copyingLegacy = legacyCopyPending(db);
    for (const row of rows) {
      runSql(db, materialize, row.workspace_revision);
      runSql(
        db,
        `UPDATE event_index SET runtime_session_present=${present},dispatch_key=${legacyKey}
        WHERE workspace_revision=? AND (runtime_session_present IS NOT (${present}) OR dispatch_key IS NOT (${legacyKey}))`,
        row.workspace_revision,
      );
      if (copyingLegacy) runSql(db, legacyCopySql, row.workspace_revision);
    }
    if (rows.length === 0) {
      if (copyingLegacy) publishLegacyRuntimeIndex(db);
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
// copying path after every deployed repository is complete, no later than 2026-12-05.
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
const mirrorTriggerNames = ["runtime_compat_event_0", "runtime_compat_event_1", "runtime_compat_event_delete"];
const legacyCopySql = `INSERT INTO ${shadow}(op_id,workspace_revision,task_id,event_json,runtime_session_present,dispatch_key)
  SELECT op_id,workspace_revision,task_id,event_json,${present},${legacyKey} FROM event_index WHERE workspace_revision=?
  ON CONFLICT(workspace_revision) DO UPDATE SET op_id=excluded.op_id,task_id=excluded.task_id,event_json=excluded.event_json,
    runtime_session_present=excluded.runtime_session_present,dispatch_key=excluded.dispatch_key`;

function legacyCopyPending(db: DatabaseSync): boolean {
  return queryRows(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", shadow).length > 0;
}

function installLegacyRuntimeTriggers(db: DatabaseSync, copying: boolean): void {
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
    ${["event_index", ...(copying ? [shadow] : [])]
      .map(
        (table) => `UPDATE ${table} SET runtime_session_present=${value}
      WHERE ${dispatch} AND json_extract(event_json,'$.payload.runtimeSessionId')=${ref}.runtime_session_id AND runtime_session_present IS NOT ${value};`,
      )
      .join("\n")} END`,
    );
}

/** Build every missing historical B-tree empty and fill it with the same bounded source pages. */
function expandLegacyRuntimeIndex(db: DatabaseSync): boolean {
  const names = new Set(queryRows<{ name: string }>(db, "PRAGMA table_info(event_index)").map((row) => row.name));
  if (!names.has("runtime_session_present"))
    runSql(db, "ALTER TABLE event_index ADD COLUMN runtime_session_present INTEGER");
  if (!names.has("dispatch_key")) runSql(db, "ALTER TABLE event_index ADD COLUMN dispatch_key TEXT");
  const indexes = new Map(
      queryRows<{ name: string; tbl_name: string }>(
        db,
        "SELECT name,tbl_name FROM sqlite_master WHERE type='index'",
      ).map((row) => [row.name, row.tbl_name]),
    ),
    pending = legacyCopyPending(db),
    missing = legacyIndexes.some(([name]) => !indexes.has(name)),
    writers = new Set(
      queryRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='trigger'").map((row) => row.name),
    ),
    copying =
      pending ||
      ((missing || legacyTriggerNames.some((name) => !writers.has(name))) &&
        queryRows(db, "SELECT 1 FROM event_index LIMIT 1").length > 0),
    created = copying && !pending,
    target = copying ? shadow : "event_index";
  if (created) {
    // Preserve the existing table's constraints/columns and actual index expressions. Never
    // create those indexes on populated history, and never invent a second edge schema.
    const schema = queryRows<{ sql: string }>(
      db,
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='event_index'",
    )[0]!.sql;
    runSql(db, schema.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`]?event_index["`]?/iu, `CREATE TABLE ${shadow}`));
    for (const index of queryRows<{ name: string; sql: string }>(
      db,
      "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='event_index' AND sql IS NOT NULL",
    )) {
      if (legacyIndexes.some(([name]) => name === index.name)) continue;
      runSql(
        db,
        `CREATE ${/^CREATE UNIQUE/iu.test(index.sql) ? "UNIQUE " : ""}INDEX IF NOT EXISTS runtime_compat_${index.name} ON ${shadow}${index.sql.slice(index.sql.indexOf("("))}`,
      );
    }
  }
  for (const [name, expression] of legacyIndexes) {
    const indexName = copying && indexes.has(name) && indexes.get(name) !== shadow ? `runtime_compat_${name}` : name;
    runSql(db, `CREATE INDEX IF NOT EXISTS ${indexName} ON ${target}${expression}`);
  }
  if (copying) {
    for (const [n, operation] of ["INSERT", "UPDATE OF op_id,workspace_revision,task_id,event_json"].entries())
      runSql(
        db,
        `CREATE TRIGGER IF NOT EXISTS runtime_compat_event_${n} AFTER ${operation} ON event_index BEGIN
        ${n ? `DELETE FROM ${shadow} WHERE workspace_revision=OLD.workspace_revision;` : ""}
        ${legacyCopySql.replace("workspace_revision=?", "workspace_revision=NEW.workspace_revision")}; END`,
      );
    runSql(
      db,
      `CREATE TRIGGER IF NOT EXISTS runtime_compat_event_delete AFTER DELETE ON event_index BEGIN
      DELETE FROM ${shadow} WHERE workspace_revision=OLD.workspace_revision; END`,
    );
  }
  installLegacyRuntimeTriggers(db, copying);
  return created;
}

function publishLegacyRuntimeIndex(db: DatabaseSync): void {
  // Rename changes schema metadata, not historical rows. Keep the old trees until contraction;
  // freeing them here would make the final page linear in repository history again.
  for (const name of [
    ...legacyTriggerNames,
    ...mirrorTriggerNames,
    "runtime_read_index_event_0",
    "runtime_read_index_event_1",
    "runtime_read_index_event_delete",
  ])
    runSql(db, `DROP TRIGGER IF EXISTS ${name}`);
  runSql(db, "ALTER TABLE event_index RENAME TO runtime_event_index_retired");
  runSql(db, `ALTER TABLE ${shadow} RENAME TO event_index`);
  installLegacyRuntimeTriggers(db, false);
  createRuntimeReadEventTriggers(db);
}

/** Base backups complete the same migration on their private copy before an old edge reads it. */
export function legacyRuntimeIndexReady(db: DatabaseSync): boolean {
  return (
    !legacyCopyPending(db) &&
    queryRows(
      db,
      "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('event_index_runtime_member_pending','event_index_runtime_dispatch_key_pending')",
    ).length === 2 &&
    queryRows(db, "SELECT 1 FROM event_index WHERE runtime_session_present IS NULL LIMIT 1").length === 0 &&
    queryRows(db, "SELECT 1 FROM event_index WHERE dispatch_key IS NULL LIMIT 1").length === 0
  );
}
