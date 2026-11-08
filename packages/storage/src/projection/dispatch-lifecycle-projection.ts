// @write-boundary-exemption rebuildable-projection
// Dispatch lifecycle read model: the kernel reducer folded over the runtime events this projection
// already applies. It is derived state only. A cache written before these tables existed (or by an
// older binary) is caught up from its own event rows on open through the same reducer, so the read
// model always equals a cold replay of the accepted events; nothing is written to the ledger.
import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  dispatchLifecycleAddress,
  dispatchLifecycleEventTypes,
  dispatchLifecycleView,
  reduceDispatchLifecycle,
  currentDispatchAttempt,
  type DispatchLifecycleGroup,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
  type DispatchLifecycleView,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { queryRows, runSql, transaction } from "./rebuildable-task-projection-sql.ts";

export const DISPATCH_LIFECYCLE_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS dispatch_lifecycle_group (
      attempt_group_id TEXT PRIMARY KEY,
      phase TEXT NOT NULL,
      current_instance_id TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS dispatch_lifecycle_cursor (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL
    );`;

const lifecycleTypes = dispatchLifecycleEventTypes.map((type) => `'${type}'`).join(",");
const CATCH_UP_BATCH = 512;

/** Fold one applied runtime event; called inside the projection's event transaction. */
export function projectDispatchLifecycleEvent(db: DatabaseSync, event: AgentRuntimeEventV1): void {
  const address = dispatchLifecycleAddress(event);
  if (address === null) return;
  const groupId =
    address.by === "group"
      ? address.attemptGroupId
      : queryRows<{ attempt_group_id: string }>(
          db,
          "SELECT attempt_group_id FROM dispatch_lifecycle_attempt WHERE runtime_session_id = ?",
          address.runtimeSessionId,
        )[0]?.attempt_group_id;
  const step = reduceDispatchLifecycle(groupId === undefined ? null : readGroup(db, groupId), event);
  if (step.kind === "applied") writeGroup(db, step.group);
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_cursor(singleton, revision) VALUES (1, ?)
     ON CONFLICT(singleton) DO UPDATE SET revision = max(revision, excluded.revision)`,
    event.workspaceRevision,
  );
}

/**
 * Replay lifecycle events this cache holds but has not folded (a cache that predates the tables,
 * or one an older binary advanced). O(unfolded runtime events) through the event-type index.
 */
export function catchUpDispatchLifecycle(
  db: DatabaseSync,
  onProgress?: (progress: { applied: number; total: number }) => void,
): void {
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
      for (const row of rows) {
        const event = JSON.parse(row.event_json) as AgentRuntimeEventV1;
        if (event.schema === "agent-runtime-event/v1") projectDispatchLifecycleEvent(db, event);
      }
    });
    applied += rows.length;
    onProgress?.({ applied, total });
  }
}

function foldedThrough(db: DatabaseSync): number {
  return Number(
    queryRows<{ revision: number }>(db, "SELECT revision FROM dispatch_lifecycle_cursor WHERE singleton = 1")[0]
      ?.revision ?? 0,
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
  runSql(
    db,
    `INSERT INTO dispatch_lifecycle_group(attempt_group_id, phase, current_instance_id, revision, group_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(attempt_group_id) DO UPDATE SET phase = excluded.phase,
       current_instance_id = excluded.current_instance_id, revision = excluded.revision,
       group_json = excluded.group_json`,
    group.attemptGroupId,
    group.phase,
    currentDispatchAttempt(group).instanceId,
    group.revision,
    JSON.stringify(group),
  );
  const current = currentDispatchAttempt(group);
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
  if (!lifecycleTablesExist(db)) return { status: "pending", ...cut };
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

/** A replica generation cut before these tables existed cannot answer; it is pending, never empty. */
function lifecycleTablesExist(db: DatabaseSync): boolean {
  return (
    queryRows(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_lifecycle_cursor'").length > 0
  );
}
