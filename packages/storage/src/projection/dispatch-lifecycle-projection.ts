// @write-boundary-exemption rebuildable-projection
// Dispatch lifecycle read model: the kernel reducer folded over the runtime and task events this
// projection already applies. It is derived state only. A cache written before these tables existed
// (or by a binary with another lifecycle model version) is refolded from its own event rows on open
// through the same reducer, so the read model always equals a cold replay of the accepted events;
// nothing is written to the ledger. Reducer rejections of historical events are audit no-ops here:
// the center writer refuses a rejected admission before it is appended (see the runtime ingress).
import type { DatabaseSync } from "node:sqlite";
import {
  DISPATCH_LIFECYCLE_MODEL_VERSION,
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  currentDispatchAttempt,
  dispatchLifecycleAddress,
  dispatchLifecycleEventTypes,
  dispatchLifecycleTaskEventTypes,
  dispatchLifecycleTaskId,
  dispatchLifecycleView,
  isDispatchLifecycleInput,
  reduceDispatchLifecycle,
  taskLeaseAfter,
  type DispatchLifecycleContext,
  type DispatchLifecycleGroup,
  type DispatchLifecycleInput,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
  type DispatchLifecycleView,
  type DispatchTaskLease,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

const LIFECYCLE_TABLES = [
  "dispatch_lifecycle_group",
  "dispatch_lifecycle_attempt",
  "dispatch_lifecycle_task_lease",
  "dispatch_lifecycle_cursor",
] as const;

export const DISPATCH_LIFECYCLE_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS dispatch_lifecycle_group (
      attempt_group_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      current_instance_id TEXT NOT NULL,
      current_execution_id TEXT,
      revision INTEGER NOT NULL,
      group_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dispatch_lifecycle_active
      ON dispatch_lifecycle_group(attempt_group_id) WHERE phase <> 'closed';
    CREATE INDEX IF NOT EXISTS dispatch_lifecycle_active_instance
      ON dispatch_lifecycle_group(current_instance_id, attempt_group_id) WHERE phase <> 'closed';
    CREATE TABLE IF NOT EXISTS dispatch_lifecycle_attempt (
      runtime_session_id TEXT PRIMARY KEY,
      dispatch_id TEXT NOT NULL,
      attempt_group_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dispatch_lifecycle_attempt_dispatch ON dispatch_lifecycle_attempt(dispatch_id);
    CREATE TABLE IF NOT EXISTS dispatch_lifecycle_task_lease (
      task_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatch_lifecycle_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL,
      model_version INTEGER NOT NULL
    );`;

// Created after the model check: an older table shape lacks the column until it is refolded.
const LIFECYCLE_EXECUTION_INDEX_SQL = `CREATE INDEX IF NOT EXISTS dispatch_lifecycle_active_execution
      ON dispatch_lifecycle_group(current_execution_id) WHERE phase <> 'closed'`;

const lifecycleTypes = [...dispatchLifecycleEventTypes, ...dispatchLifecycleTaskEventTypes]
  .map((type) => `'${type}'`)
  .join(",");
const CATCH_UP_BATCH = 512;

/** Fold one applied event; called inside the projection's event transaction. */
export function projectDispatchLifecycleEvent(
  db: DatabaseSync,
  event: { readonly schema: string; readonly type: string },
): void {
  if (!isDispatchLifecycleInput(event)) return;
  const input = event as DispatchLifecycleInput,
    taskId = dispatchLifecycleTaskId(input),
    context: DispatchLifecycleContext = { taskLease: taskId === null ? null : readTaskLease(db, taskId) },
    address = dispatchLifecycleAddress(input, context);
  for (const groupId of address === null ? [] : addressedGroups(db, address)) {
    const previous = groupId === null ? null : readGroup(db, groupId),
      step = reduceDispatchLifecycle(previous, input, context);
    if (step.kind === "applied") writeGroup(db, step.group);
  }
  const lease = taskLeaseAfter(input);
  if (lease !== undefined && taskId !== null) writeTaskLease(db, taskId, lease);
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_cursor(singleton, revision, model_version) VALUES (1, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET revision = max(revision, excluded.revision)`,
    input.workspaceRevision,
    DISPATCH_LIFECYCLE_MODEL_VERSION,
  );
}

function addressedGroups(
  db: DatabaseSync,
  address: NonNullable<ReturnType<typeof dispatchLifecycleAddress>>,
): readonly (string | null)[] {
  if (address.by === "group") return [address.attemptGroupId];
  if (address.by === "session")
    return [
      queryRows<{ attempt_group_id: string }>(
        db,
        "SELECT attempt_group_id FROM dispatch_lifecycle_attempt WHERE runtime_session_id = ?",
        address.runtimeSessionId,
      )[0]?.attempt_group_id ?? null,
    ];
  return queryRows<{ attempt_group_id: string }>(
    db,
    `SELECT attempt_group_id FROM dispatch_lifecycle_group
     WHERE phase <> 'closed' AND current_execution_id IN (${address.executionIds.map(() => "?").join(",")})
     ORDER BY attempt_group_id`,
    ...address.executionIds,
  ).map(({ attempt_group_id }) => attempt_group_id);
}

/**
 * Refold lifecycle events this cache holds but has not folded (a cache that predates the tables,
 * one of another model version, or one an older binary advanced). O(unfolded lifecycle events)
 * through the event-type index.
 */
export function catchUpDispatchLifecycle(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
): void {
  ensureDispatchLifecycleModel(db);
  let applied = 0,
    total = 0;
  for (;;) {
    const after = foldedThrough(db),
      rows = queryRows<{ event_json: string }>(
        db,
        `SELECT i.event_json FROM event_summary s
         JOIN event_index i ON i.workspace_revision = s.workspace_revision
         WHERE s.event_type IN (${lifecycleTypes}) AND s.workspace_revision > ?
         ORDER BY s.workspace_revision LIMIT ${CATCH_UP_BATCH}`,
        after,
      );
    if (rows.length === 0) return;
    if (total === 0)
      total = Number(
        queryRows<{ count: number }>(
          db,
          `SELECT count(*) AS count FROM event_summary WHERE event_type IN (${lifecycleTypes}) AND workspace_revision > ?`,
          after,
        )[0]!.count,
      );
    transaction(db, () => {
      for (const row of rows) projectDispatchLifecycleEvent(db, JSON.parse(row.event_json) as DispatchLifecycleInput);
    });
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

/** Lifecycle state of another model version is discarded and refolded from the event rows. */
function ensureDispatchLifecycleModel(db: DatabaseSync): void {
  const columns = queryRows<{ name: string }>(db, "PRAGMA table_info(dispatch_lifecycle_cursor)").map(
      ({ name }) => name,
    ),
    version = columns.includes("model_version")
      ? queryRows<{ model_version: number }>(
          db,
          "SELECT model_version FROM dispatch_lifecycle_cursor WHERE singleton = 1",
        )[0]?.model_version
      : -1;
  if (version !== undefined && version !== DISPATCH_LIFECYCLE_MODEL_VERSION) {
    for (const table of LIFECYCLE_TABLES) runSql(db, `DROP TABLE IF EXISTS ${table}`);
    for (const statement of DISPATCH_LIFECYCLE_TABLES_SQL.split(";")) if (statement.trim()) runSql(db, statement);
  }
  runSql(db, LIFECYCLE_EXECUTION_INDEX_SQL);
}

function foldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM dispatch_lifecycle_cursor WHERE singleton = 1")[0]
      ?.revision ?? 0,
  );
}

function readTaskLease(db: DatabaseSync, taskId: string): DispatchTaskLease | null {
  const row = queryRows<{ execution_id: string; version: number }>(
    db,
    "SELECT execution_id, version FROM dispatch_lifecycle_task_lease WHERE task_id = ?",
    taskId,
  )[0];
  return row ? { executionId: row.execution_id, version: Number(row.version) } : null;
}

function writeTaskLease(db: DatabaseSync, taskId: string, lease: DispatchTaskLease | null): void {
  if (lease === null) runSql(db, "DELETE FROM dispatch_lifecycle_task_lease WHERE task_id = ?", taskId);
  else
    runSql(
      db,
      `INSERT INTO dispatch_lifecycle_task_lease(task_id, execution_id, version) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET execution_id = excluded.execution_id, version = excluded.version`,
      taskId,
      lease.executionId,
      lease.version,
    );
}

function readGroup(db: DatabaseSync, attemptGroupId: string): DispatchLifecycleGroup | null {
  const row = queryRows<{ group_json: string }>(
    db,
    "SELECT group_json FROM dispatch_lifecycle_group WHERE attempt_group_id = ?",
    attemptGroupId,
  )[0];
  return row ? (JSON.parse(row.group_json) as DispatchLifecycleGroup) : null;
}

function writeGroup(db: DatabaseSync, group: DispatchLifecycleGroup): void {
  const current = currentDispatchAttempt(group);
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_group(attempt_group_id, phase, current_instance_id, current_execution_id, revision, group_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(attempt_group_id) DO UPDATE SET phase = excluded.phase,
       current_instance_id = excluded.current_instance_id, current_execution_id = excluded.current_execution_id,
       revision = excluded.revision, group_json = excluded.group_json`,
    group.attemptGroupId,
    group.phase,
    current.instanceId,
    current.task?.executionId ?? null,
    group.revision,
    JSON.stringify(group),
  );
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_attempt(runtime_session_id, dispatch_id, attempt_group_id) VALUES (?, ?, ?)
     ON CONFLICT(runtime_session_id) DO NOTHING`,
    current.runtimeSessionId,
    current.dispatchId,
    group.attemptGroupId,
  );
}

/** The storage half of `readDispatchLifecycle`: indexed point reads and a bounded active page. */
export function readDispatchLifecycleRows(
  db: DatabaseSync,
  query: DispatchLifecycleQuery,
  cut: { readonly watermark: number; readonly sourceRevision: number },
): DispatchLifecycleRead {
  if (!lifecycleModelCurrent(db)) return { status: "pending", ...cut };
  if (query.by === "group") {
    const group = readGroup(db, query.attemptGroupId);
    return ready(cut, group ? [dispatchLifecycleView(group)] : [], null);
  }
  if (query.by === "dispatch" || query.by === "session") {
    const keys = query.by === "dispatch" ? query.dispatchIds : [query.runtimeSessionId];
    if (keys.length > DISPATCH_LIFECYCLE_PAGE_LIMIT)
      throw new Error(`dispatch lifecycle point reads accept at most ${DISPATCH_LIFECYCLE_PAGE_LIMIT} ids`);
    const column = query.by === "dispatch" ? "dispatch_id" : "runtime_session_id",
      rows = keys.length
        ? queryRows<{ dispatch_id: string; group_json: string }>(
            db,
            `SELECT a.dispatch_id, g.group_json FROM dispatch_lifecycle_attempt a
             JOIN dispatch_lifecycle_group g USING(attempt_group_id)
             WHERE a.${column} IN (${keys.map(() => "?").join(",")})`,
            ...keys,
          )
        : [];
    return ready(
      cut,
      rows.map((row) => dispatchLifecycleView(JSON.parse(row.group_json) as DispatchLifecycleGroup, row.dispatch_id)),
      null,
    );
  }
  const limit = Math.min(Math.max(1, Math.trunc(query.limit)), DISPATCH_LIFECYCLE_PAGE_LIMIT),
    clauses = ["phase <> 'closed'"],
    parameters: (string | number)[] = [];
  if (query.instanceId !== undefined) {
    clauses.push("current_instance_id = ?");
    parameters.push(query.instanceId);
  }
  if (query.cursor !== undefined) {
    clauses.push("attempt_group_id > ?");
    parameters.push(query.cursor);
  }
  const groups = queryRows<{ group_json: string }>(
      db,
      `SELECT group_json FROM dispatch_lifecycle_group WHERE ${clauses.join(" AND ")}
       ORDER BY attempt_group_id LIMIT ?`,
      ...parameters,
      limit + 1,
    ).map(({ group_json }) => JSON.parse(group_json) as DispatchLifecycleGroup),
    page = groups.slice(0, limit);
  return ready(
    cut,
    page.map((group) => dispatchLifecycleView(group)),
    groups.length > limit ? page.at(-1)!.attemptGroupId : null,
  );
}

function ready(
  cut: { readonly watermark: number; readonly sourceRevision: number },
  rows: readonly DispatchLifecycleView[],
  nextCursor: string | null,
): DispatchLifecycleRead {
  return { status: "ready", ...cut, rows, nextCursor };
}

/**
 * A replica generation cut before these tables existed, or folded by another lifecycle model
 * version, cannot answer: it is pending, never an empty ready page.
 */
function lifecycleModelCurrent(db: DatabaseSync): boolean {
  const columns = queryRows<{ name: string }>(db, "PRAGMA table_info(dispatch_lifecycle_cursor)").map(
    ({ name }) => name,
  );
  if (!columns.includes("model_version")) return false;
  const version = queryRows<{ model_version: number }>(
    db,
    "SELECT model_version FROM dispatch_lifecycle_cursor WHERE singleton = 1",
  )[0]?.model_version;
  return version === undefined || version === DISPATCH_LIFECYCLE_MODEL_VERSION;
}
