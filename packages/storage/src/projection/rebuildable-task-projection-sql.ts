import type * as ReadSet from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, type Hash } from "node:crypto";
import type { SQLOutputValue, StatementSync } from "node:sqlite";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { canonicalizeContractValue } from "@harness-anything/kernel/internal/domain/task.ts";
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
import type { EventStreamPort } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";

// SQL execution, projection watermark, canonical serialization, and state digest primitives.
const stateDigestTables = [
  ["event_index", "op_id"],
  ["event_summary", "workspace_revision"],
  ["artifact_entity_state", "entity_kind, entity_id"],
  ["document", "path"],
  ["document_history", "path"],
  ["materialization_hold", "owner_ref, relation_id"],
  ["preset_snapshot", "digest"],
  ["runtime_installation", "installation_id"],
  ["runtime_session", "runtime_session_id"],
  ["task_snapshot", "task_id"],
  ["task_package", "task_id"],
  ["task_generation", "task_id"],
  ["task_relation", "relation_id"],
  ["task_progress", "workspace_revision"],
  ["entity_projection", "entity_kind, task_id, entity_id"],
  ["archived_entity", "entity_kind, entity_id"],
  ["edge", "task_id, edge_id, iteration"],
  ["lease_cas", "task_id"],
  ["lease_interval", "task_id, execution_id, acquired_revision"],
  ["fact", "fact_id"],
  ["relation_edge", "relation_id"],
  ["decision", "decision_id"],
  ["decision_option", "decision_id, kind, option_id"],
  ["decision_claim", "decision_id, claim_id"],
  ["decision_judgment_consent", "consent_id"],
  ["decision_amendment", "amendment_id"],
  ["decision_content_pin", "pin_id"],
  ["decision_review_event", "event_id"],
  ["dispatch_lifecycle_group", "attempt_group_id"],
  ["dispatch_lifecycle_attempt", "runtime_session_id"],
  ["dispatch_lifecycle_task_lease", "task_id"],
  ["runtime_inbox_group", "inbox_id"],
] as const;

/** Disposable lookup and derived columns added after a table's state fingerprint was defined. */
const stateDigestColumns: Partial<Record<(typeof stateDigestTables)[number][0], string>> = {
  event_index: "op_id,workspace_revision,task_id,event_json",
  // Freshness is derived from the other projected rows at the same cut (dec_E34C4284B48AFAF152D7BF1980).
  relation_edge:
    "relation_id,source_ref,target_ref,relation_type,state,target_observed_version,owner_ref,workspace_revision,updated_at,row_json",
};
const stateDigestChunkBytes = 1024 * 1024;

export function watermark(db: DatabaseSync): number {
  const row = prepareQuery(db, "SELECT watermark FROM projection_meta WHERE singleton = 1", (sql) =>
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */ db.prepare(
      sql,
    ),
  ).get() as { readonly watermark: number };
  return Number(row.watermark);
}

export function readProjectionCut(
  db: DatabaseSync,
  readHead: EventStreamPort["readHead"],
): {
  readonly status: ReadSet.ReadSetProjectionCut["status"];
  readonly watermark: number;
  readonly sourceRevision: number;
} {
  const current = watermark(db),
    sourceRevision = readHead()?.revision ?? 0;
  return {
    status: current === sourceRevision ? "ready" : "pending",
    watermark: current,
    sourceRevision,
  };
}

export function isAtSourceCut(db: DatabaseSync, sourceRevision: number): boolean {
  const state =
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.prepare("SELECT watermark, scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
      readonly watermark: number;
      readonly scan_cursor: string | null;
      readonly scanned_revision: number;
    };
  return (
    Number(state.watermark) === sourceRevision &&
    state.scan_cursor === null &&
    Number(state.scanned_revision) === sourceRevision &&
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.prepare("SELECT 1 FROM event_source LIMIT 1").get() === undefined
  );
}

// Hashes every projection row, so only explicit rebuilds and read-side checks call it; writes never do.
export function readStateDigest(db: DatabaseSync, sourceRevision: number): `sha256:${string}` | null {
  return queryTransaction(db, () => {
    if (!isAtSourceCut(db, sourceRevision)) return null;
    let digest = sha256Text("task-projection-state/v1");
    for (const [table, order] of stateDigestTables) {
      digest = sha256Text(`${digest}\n${table}`);
      if (table === "document" || table === "document_history") {
        digest = digestDocumentRows(db, digest, table);
        continue;
      }
      // Disposable event lookup fields are not part of the pre-expansion state fingerprint.
      for (const row of prepareQuery(
        db,
        `SELECT ${stateDigestColumns[table] ?? "*"} FROM ${table} ORDER BY ${order}`,
      ).iterate())
        digest = sha256Text(`${digest}\n${canonicalJson(row as ProjectionSqlRow)}`);
    }
    return `sha256:${digest}` as const;
  });
}

function digestDocumentRows(db: DatabaseSync, digest: string, table: "document" | "document_history"): string {
  const documents = prepareQuery(
      db,
      `SELECT path, workspace_revision, length(CAST(value_json AS BLOB)) AS value_json_bytes FROM ${table} ORDER BY path`,
    ).iterate() as Iterable<{
      readonly path: string;
      readonly workspace_revision: number;
      readonly value_json_bytes: number;
    }>,
    chunkQuery = prepareQuery(
      db,
      `SELECT substr(CAST(value_json AS BLOB), ?, ?) AS chunk FROM ${table} WHERE path = ?`,
    );
  for (const { path, workspace_revision, value_json_bytes } of documents) {
    function* readChunks(): Iterable<Uint8Array> {
      for (let offset = 0; offset < value_json_bytes; offset += stateDigestChunkBytes) {
        const row = chunkQuery.get(offset + 1, stateDigestChunkBytes, path) as
          | { readonly chunk: Uint8Array }
          | undefined;
        if (row?.chunk === undefined) throw new Error(`document ${path} disappeared during state digest`);
        yield row.chunk;
      }
    }
    digest = hashCanonicalJsonTextFieldChunks(
      digest,
      { path, workspace_revision, value_json: "" },
      "value_json",
      readChunks(),
    );
  }
  return digest;
}
export function transaction<A>(db: DatabaseSync, run: () => A): A {
  /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
    }
    throw error;
  }
}

export function queryTransaction<A>(db: DatabaseSync, run: () => A): A {
  if (db.isTransaction) return run();
  /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
  db.exec("BEGIN");
  try {
    const value = run();
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
    }
    throw error;
  }
}
type SqlValue = string | number | bigint | Uint8Array | null;
export function runSql(db: DatabaseSync, sql: string, ...values: readonly SqlValue[]): number | bigint {
  return prepareQuery(db, sql, (text) =>
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */ db.prepare(
      text,
    ),
  ).run(...values).changes;
}
const connectionStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** Release the cache before close finalizes the connection's native statements. */
export function closeProjectionConnection(db: DatabaseSync): void {
  connectionStatements.delete(db);
  db.close();
}
/** Reuse a statement for the connection's lifetime. Call sites that carry their own
 * write-boundary identity pass the `prepare` that performs it. */
export function prepareQuery(
  db: DatabaseSync,
  sql: string,
  prepare = (text: string) =>
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */ db.prepare(
      text,
    ),
): StatementSync {
  let statements = connectionStatements.get(db);
  if (statements === undefined) connectionStatements.set(db, (statements = new Map()));
  let statement = statements.get(sql);
  if (statement === undefined) statements.set(sql, (statement = prepare(sql)));
  return statement;
}
/** Table names read once per connection: every table is created while a connection initializes. */
const connectionTables = new WeakMap<DatabaseSync, ReadonlySet<string>>();
export function projectionTables(db: DatabaseSync): ReadonlySet<string> {
  let tables = connectionTables.get(db);
  if (tables === undefined)
    connectionTables.set(
      db,
      (tables = new Set(
        queryRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(({ name }) => String(name)),
      )),
    );
  return tables;
}
export type ProjectionSqlRow = Readonly<Record<string, SQLOutputValue>>;
export function queryRow<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): Row | undefined {
  return prepareQuery(db, sql).get(...values) as Row | undefined;
}
export function queryRows<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): readonly Row[] {
  return queryPreparedRows<Row>(prepareQuery(db, sql), ...values);
}
export function queryPreparedRows<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  statement: StatementSync,
  ...values: readonly SqlValue[]
): readonly Row[] {
  return statement.all(...values) as Row[];
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}

export function hashCanonicalJsonTextFieldChunks(
  previousDigest: string,
  row: Readonly<Record<string, unknown>>,
  field: string,
  chunks: Iterable<Uint8Array>,
): string {
  const { hash, suffix } = beginCanonicalJsonTextFieldHash(previousDigest, row, field),
    decoder = new TextDecoder();
  for (const chunk of chunks) hash.update(escapeJsonStringContent(decoder.decode(chunk, { stream: true })));
  hash.update(escapeJsonStringContent(decoder.decode()));
  return hash.update(suffix).digest("hex");
}

export async function hashCanonicalJsonTextFieldChunksAsync(
  previousDigest: string,
  row: Readonly<Record<string, unknown>>,
  field: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<string> {
  const { hash, suffix } = beginCanonicalJsonTextFieldHash(previousDigest, row, field),
    decoder = new TextDecoder();
  for await (const chunk of chunks) hash.update(escapeJsonStringContent(decoder.decode(chunk, { stream: true })));
  hash.update(escapeJsonStringContent(decoder.decode()));
  return hash.update(suffix).digest("hex");
}

function beginCanonicalJsonTextFieldHash(
  previousDigest: string,
  row: Readonly<Record<string, unknown>>,
  field: string,
): { readonly hash: Hash; readonly suffix: string } {
  const serialized = canonicalJson({ ...row, [field]: "" }),
    marker = `${JSON.stringify(field)}:""`,
    markerStart = serialized.indexOf(marker);
  if (markerStart === -1) throw new Error(`canonical JSON row is missing streamed field ${field}`);
  const contentEnd = markerStart + marker.length - 1;
  return {
    hash: createHash("sha256").update(`${previousDigest}\n`).update(serialized.slice(0, contentEnd)),
    suffix: serialized.slice(contentEnd),
  };
}

function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value)!.slice(1, -1);
}

const INBOX_TABLES = ["runtime_inbox_group", "runtime_inbox_cursor"] as const;
const INBOX_CATCH_UP_BATCH = 512;
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
    previous = readInboxGroup(db, input.payload.inboxId),
    step = reduceRuntimeInbox(previous, input);
  if (step.kind === "applied") writeInboxGroup(db, step.group);
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
    const after = inboxFoldedThrough(db),
      rows = queryRows<{ event_json: string }>(
        db,
        `SELECT i.event_json FROM event_summary s
         JOIN event_index i ON i.workspace_revision = s.workspace_revision
         WHERE s.event_type IN (${inboxEventTypeSql}) AND s.workspace_revision > ?
         ORDER BY s.workspace_revision LIMIT ${INBOX_CATCH_UP_BATCH}`,
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

function inboxFoldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM runtime_inbox_cursor WHERE singleton = 1")[0]?.revision ??
      0,
  );
}

function readInboxGroup(db: DatabaseSync, inboxId: string): RuntimeInboxGroup | null {
  const row = queryRows<{ group_json: string }>(
    db,
    "SELECT group_json FROM runtime_inbox_group WHERE inbox_id = ?",
    inboxId,
  )[0];
  return row ? (JSON.parse(row.group_json) as RuntimeInboxGroup) : null;
}

function writeInboxGroup(db: DatabaseSync, group: RuntimeInboxGroup): void {
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
    const group = readInboxGroup(db, query.inboxId);
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
