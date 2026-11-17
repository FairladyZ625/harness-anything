import type { DatabaseSync } from "node:sqlite";
import {
  RUNTIME_INBOX_MODEL_VERSION,
  RUNTIME_INBOX_PAGE_LIMIT,
  inboxHasOpenItems,
  isRuntimeInboxInput,
  reduceRuntimeInbox,
  runtimeInboxEventTypes,
  type RuntimeInboxGroup,
  type RuntimeInboxInput,
  type RuntimeInboxQuery,
  type RuntimeInboxRead,
} from "@harness-anything/kernel/internal/domain/runtime-inbox.ts";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const INBOX_TABLES = ["runtime_inbox_group", "runtime_inbox_cursor"] as const;
const CATCH_UP_BATCH = 512;
const inboxEventTypeSql = runtimeInboxEventTypes.map((type) => `'${type}'`).join(",");

export const RUNTIME_INBOX_TABLES_SQL = `
    /* @gate-identity state-store/task.projection.runtime_inbox_group */ CREATE TABLE IF NOT EXISTS runtime_inbox_group (
      inbox_id TEXT PRIMARY KEY,
      has_open_items INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      group_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_inbox_open_idx
      ON runtime_inbox_group(inbox_id) WHERE has_open_items = 1;
    /* @gate-identity state-store/task.projection.runtime_inbox_cursor */ CREATE TABLE IF NOT EXISTS runtime_inbox_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL,
      model_version INTEGER NOT NULL
    );`;

/** Fold one accepted canonical event; runs inside the SQLite projection event transaction. */
export function projectRuntimeInboxEvent(
  db: DatabaseSync,
  event: { readonly schema: string; readonly type: string },
): void {
  if (!isRuntimeInboxInput(event)) return;
  const input = event as RuntimeInboxInput,
    previous = readGroup(db, input.payload.inboxId),
    step = reduceRuntimeInbox(previous, input);
  if (step.kind === "applied") writeGroup(db, step.group);
  runSql(
    db,
    `INSERT INTO runtime_inbox_cursor(singleton, revision, model_version) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET revision = max(revision, excluded.revision)`,
    input.workspaceRevision,
    RUNTIME_INBOX_MODEL_VERSION,
  );
}

/** Refold inbox events cached in SQLite when opening an older schema/model version. */
export function catchUpRuntimeInbox(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
): void {
  ensureRuntimeInboxModel(db);
  let applied = 0,
    total = 0;
  for (;;) {
    const after = foldedThrough(db),
      rows = queryRows<{ event_json: string }>(
        db,
        `SELECT i.event_json FROM event_summary s
         JOIN event_index i ON i.workspace_revision = s.workspace_revision
         WHERE s.event_type IN (${inboxEventTypeSql}) AND s.workspace_revision > ?
         ORDER BY s.workspace_revision LIMIT ${CATCH_UP_BATCH}`,
        after,
      );
    if (rows.length === 0) return;
    if (total === 0)
      total = Number(
        queryRows<{ count: number }>(
          db,
          `SELECT count(*) AS count FROM event_summary WHERE event_type IN (${inboxEventTypeSql}) AND workspace_revision > ?`,
          after,
        )[0]!.count,
      );
    transaction(db, () => {
      for (const row of rows) projectRuntimeInboxEvent(db, JSON.parse(row.event_json) as RuntimeInboxInput);
    });
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

function ensureRuntimeInboxModel(db: DatabaseSync): void {
  const cursorColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(runtime_inbox_cursor)").map(
      ({ name }) => name,
    ),
    groupColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(runtime_inbox_group)").map(({ name }) => name),
    version = cursorColumns.includes("model_version")
      ? queryRows<{ model_version: number }>(
          db,
          "SELECT model_version FROM runtime_inbox_cursor WHERE singleton = 1",
        )[0]?.model_version
      : -1;
  if (!groupColumns.includes("has_open_items") || (version !== undefined && version !== RUNTIME_INBOX_MODEL_VERSION)) {
    for (const table of INBOX_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table}`);
    for (const statement of RUNTIME_INBOX_TABLES_SQL.split(";")) if (statement.trim()) runSql(db, statement);
  }
}

function foldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM runtime_inbox_cursor WHERE singleton = 1")[0]?.revision ??
      0,
  );
}

function readGroup(db: DatabaseSync, inboxId: string): RuntimeInboxGroup | null {
  const row = queryRows<{ group_json: string }>(
    db,
    "SELECT group_json FROM runtime_inbox_group WHERE inbox_id = ?",
    inboxId,
  )[0];
  return row ? (JSON.parse(row.group_json) as RuntimeInboxGroup) : null;
}

function writeGroup(db: DatabaseSync, group: RuntimeInboxGroup): void {
  runSql(
    db,
    `INSERT INTO runtime_inbox_group(inbox_id, has_open_items, revision, group_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(inbox_id) DO UPDATE SET
       has_open_items = excluded.has_open_items,
       revision = excluded.revision,
       group_json = excluded.group_json`,
    group.inboxId,
    inboxHasOpenItems(group) ? 1 : 0,
    group.lastRevision,
    JSON.stringify(group),
  );
}

/** Indexed point read (`by: "inbox"`) or bounded open-inbox scan (`by: "open"`). */
export function readRuntimeInboxRows(
  db: DatabaseSync,
  query: RuntimeInboxQuery,
  cut: { readonly watermark: number; readonly sourceRevision: number },
): RuntimeInboxRead {
  if (!inboxModelCurrent(db)) return { status: "pending", ...cut };
  if (query.by === "inbox") {
    const group = readGroup(db, query.inboxId);
    return { status: "ready", ...cut, rows: group ? [group] : [], nextCursor: null };
  }
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? RUNTIME_INBOX_PAGE_LIMIT)), RUNTIME_INBOX_PAGE_LIMIT),
    clauses = ["has_open_items = 1"],
    parameters: (string | number)[] = [];
  if (query.cursor !== undefined) {
    clauses.push("inbox_id > ?");
    parameters.push(query.cursor);
  }
  const groups = queryRows<{ group_json: string }>(
      db,
      `SELECT group_json FROM runtime_inbox_group WHERE ${clauses.join(" AND ")} ORDER BY inbox_id LIMIT ?`,
      ...parameters,
      limit + 1,
    ).map(({ group_json }) => JSON.parse(group_json) as RuntimeInboxGroup),
    page = groups.slice(0, limit);
  return {
    status: "ready",
    ...cut,
    rows: page,
    nextCursor: groups.length > limit ? page.at(-1)!.inboxId : null,
  };
}

function inboxModelCurrent(db: DatabaseSync): boolean {
  const cursorColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(runtime_inbox_cursor)").map(
      ({ name }) => name,
    ),
    groupColumns = queryRows<{ name: string }>(db, "PRAGMA table_info(runtime_inbox_group)").map(({ name }) => name);
  if (!cursorColumns.includes("model_version") || !groupColumns.includes("has_open_items")) return false;
  const version = queryRows<{ model_version: number }>(
    db,
    "SELECT model_version FROM runtime_inbox_cursor WHERE singleton = 1",
  )[0]?.model_version;
  return version === undefined || version === RUNTIME_INBOX_MODEL_VERSION;
}
