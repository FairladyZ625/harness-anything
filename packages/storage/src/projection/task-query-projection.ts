import { publicRuntimeSession } from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
// No @write-boundary-exemption marker is needed here: this module never opens a
// database itself — it receives the already-open rebuildable projection handle
// from rebuildable-task-projection.ts, which owns the governed writable open.
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSession } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { TaskProgressEventV1 } from "@harness-anything/kernel/internal/domain/task-progress-event.ts";
import { readRelationCycleAudit } from "./relation-cycle-audit-projection.ts";
import { validateTaskV2, type TaskV2 } from "@harness-anything/kernel/internal/domain/task.ts";
import type { TaskIndexProjectionRow } from "@harness-anything/kernel";
import type {
  ProjectionPage,
  RelationCycleAudit,
  TaskProjectionListQuery,
  TaskRelationNeighborhoodQuery,
  TaskRelationNeighborhoodWindow,
  TaskRelationProjectionRow,
  TaskRelationQuery,
} from "@harness-anything/kernel";
export type {
  ProjectionPage,
  RelationCycleAudit,
  RelationCycleAuditRead,
  RelationCycleIssue,
  TaskProjectionListQuery,
  TaskRelationNeighborhoodQuery,
  TaskRelationNeighborhoodWindow,
  TaskRelationProjectionRow,
  TaskRelationQuery,
} from "@harness-anything/kernel";
import { prepareQuery, queryRows, type ProjectionSqlRow } from "./rebuildable-task-projection-sql.ts";
import { isRelationFreshness } from "./relation-freshness-columns.ts";

/** SQL query implementation for the rebuildable task projection. */
export interface NarrowTaskRow {
  readonly task_id: string;
  readonly package_path: string | null;
  readonly generation: "v0" | "v1";
  readonly workspace_revision: number;
  readonly created_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
  readonly pinned: number;
  readonly presentation_status: TaskV2["status"] | null;
}

/** dec_mr7v4h6t: the only production work-status derivation. The correlated
 * recursion visits this root's descendants using the existing parent index.
 * Unary + removes TEXT affinity so SQLite can search the JSON parent index.
 * UNION terminates cycles; the root itself is never a member, and a superseded
 * archived plan is retired rather than counted as an unfinished member. No writes.
 * A planned root with any started member presents active (CEO ruling 2026-10-11:
 * a work whose subtask started is in progress, never "planned"); completion
 * stays explicit — only an all-terminal subtree presents done/cancelled.
 *
 * Each question is asked as its own EXISTS ... LIMIT 1 rather than as one
 * aggregate over a materialized `members` CTE. Both spellings read the same
 * subtree through the same recursive CTE, but the aggregate has to produce
 * every member before it can answer, so a single work root's cost was the whole
 * subtree (a 102,921-member root cost 117.9 ms of a 119.1 ms 5M page). An
 * EXISTS stops at the first witness: it is O(1) when the answer is decided by
 * the root's own members near the root, and never worse than the aggregate when
 * the subtree really is entirely terminal, because no answer exists without
 * visiting all of it.
 *
 * The four questions are asked in the order the aggregate's CASE decided them,
 * and each one is skipped when an earlier answer already settles the result:
 *   1. any non-terminal member?  (no  -> the all-terminal arm may apply)
 *   2. does the subtree have members at all?  (this is the aggregate's COUNT(*) > 0)
 *   3. is any member done?  (picks done vs cancelled, only when (1) said no)
 *   4. planned root with a started member -> active (only when (1) said yes)
 * COALESCE keeps the historical fallback to the root's own status, which is what
 * an aggregation over zero members produced. */
/** `ha task supersede` archives the replaced task and records its replacement, but the immutable
 * event status of the replaced plan stays where it was (often planned). That pair is a retired
 * plan, not open work — `workspace-scope-read`'s `supersededArchivedLeaf` already drops it from the
 * work's open accounting — so the status derivation must not see it as an unfinished member.
 * Because the walk descends through `members`, skipping the retired node also retires its
 * descendants with it: the replacement carries the future work.
 * Archived without a replacement keeps its existing meaning: the work was put aside, not replaced.
 * Read the snapshot JSON rather than the generated `package_disposition` column so the same SQL also
 * runs against the lighter in-memory projection fixtures. */
const RETIRED_PLAN_SQL = `NOT (
        COALESCE(json_extract(child.snapshot_json, '$.task.packageDisposition'), 'active') = 'archived'
        AND json_extract(child.snapshot_json, '$.task.supersededBy') IS NOT NULL
      )`;

const PRESENTATION_SUBTREE_SQL = `WITH RECURSIVE members(task_id, status) AS (
      SELECT child.task_id, child.status FROM task_snapshot AS child
      WHERE json_extract(child.snapshot_json, '$.task.metadata.parentTaskId') = +task_snapshot.task_id
        AND child.task_id <> task_snapshot.task_id
        AND ${RETIRED_PLAN_SQL}
      UNION
      SELECT child.task_id, child.status FROM task_snapshot AS child JOIN members AS parent
        ON json_extract(child.snapshot_json, '$.task.metadata.parentTaskId') = +parent.task_id
      WHERE child.task_id <> task_snapshot.task_id
        AND ${RETIRED_PLAN_SQL}
    )`;

const PRESENTATION_STATUS_SQL = `CASE
  WHEN task_snapshot.status IN ('done', 'cancelled') THEN task_snapshot.status
  WHEN json_extract(task_snapshot.snapshot_json, '$.task.taskClass') = 'work' OR (
    json_extract(task_snapshot.snapshot_json, '$.task.metadata.parentTaskId') IS NULL AND EXISTS (
      SELECT 1 FROM task_snapshot AS child
      WHERE json_extract(child.snapshot_json, '$.task.metadata.parentTaskId') = +task_snapshot.task_id
    )
  ) THEN COALESCE(CASE
      WHEN NOT EXISTS (${PRESENTATION_SUBTREE_SQL}
        SELECT 1 FROM members WHERE COALESCE(status IN ('done', 'cancelled'), 0) = 0 LIMIT 1)
      THEN CASE
        WHEN EXISTS (${PRESENTATION_SUBTREE_SQL} SELECT 1 FROM members LIMIT 1)
        THEN CASE
          WHEN EXISTS (${PRESENTATION_SUBTREE_SQL} SELECT 1 FROM members WHERE status = 'done' LIMIT 1)
          THEN 'done'
          ELSE 'cancelled'
        END
      END
      WHEN task_snapshot.status = 'planned' AND EXISTS (${PRESENTATION_SUBTREE_SQL}
        SELECT 1 FROM members WHERE COALESCE(status NOT IN ('planned', 'cancelled'), 0) = 1 LIMIT 1)
      THEN 'active'
    END, task_snapshot.status)
  ELSE task_snapshot.status END`;

export function readTaskPresentationStatus(db: DatabaseSync, taskId: string): TaskV2["status"] | null {
  return (
    queryRows<{ readonly status: TaskV2["status"] }>(
      db,
      `SELECT ${PRESENTATION_STATUS_SQL} AS status FROM task_snapshot WHERE task_id = ?`,
      taskId,
    )[0]?.status ?? null
  );
}

/** One projection scan for the CLI task index. The row is intentionally limited
 * to list/tree fields, so callers do not hydrate executions, reviews, leases, or
 * relation graphs only to discard them after a metadata filter. */
/** Direct children with an active package, counted across the whole ledger for the given parents. */
export function readTaskChildCounts(
  db: DatabaseSync,
  parentTaskIds: readonly string[],
): Readonly<Record<string, number>> {
  if (parentTaskIds.length === 0) return {};
  const parent = "json_extract(snapshot_json, '$.task.metadata.parentTaskId')";
  return Object.fromEntries(
    queryRows<{ readonly parent_task_id: string; readonly child_count: number }>(
      db,
      [
        `SELECT ${parent} AS parent_task_id, COUNT(*) AS child_count FROM task_snapshot`,
        "WHERE package_disposition = 'active'",
        `AND ${parent} IN (SELECT value FROM json_each(?)) GROUP BY parent_task_id`,
      ].join(" "),
      JSON.stringify(parentTaskIds),
    ).map((row) => [row.parent_task_id, Number(row.child_count)]),
  );
}

export function readTaskIndexRows(
  db: DatabaseSync,
  query: TaskProjectionListQuery = {},
): { readonly rows: readonly TaskIndexProjectionRow[]; readonly page: ProjectionPage | null } {
  if (query.scopeRootTaskId !== undefined) return readTaskScopeRows(db, query);
  const values: (string | number | null)[] = [],
    where: string[] = [],
    field = (jsonPath: string) => `json_extract(task_snapshot.snapshot_json, '${jsonPath}')`;
  for (const [value, expression] of [
    [query.status, query.presentationStatus ? PRESENTATION_STATUS_SQL : "task_snapshot.status"],
    [query.workKind, field("$.task.metadata.workKind")],
    [query.riskTier, field("$.task.metadata.riskTier")],
    [query.urgency, field("$.task.metadata.urgency")],
  ] as const)
    if (value !== undefined) {
      where.push(`${expression} = ?`);
      values.push(value);
    }
  if (query.workRootsOnly)
    where.push(
      `(json_extract(task_snapshot.snapshot_json, '$.task.taskClass') = 'work' OR (` +
        `${field("$.task.metadata.parentTaskId")} IS NULL AND EXISTS (` +
        "SELECT 1 FROM task_snapshot AS child WHERE json_extract(child.snapshot_json, '$.task.metadata.parentTaskId') = +task_snapshot.task_id" +
        ")))",
    );
  if (query.openOnly) where.push("task_snapshot.status NOT IN ('done', 'cancelled')");
  if (query.parentTaskId !== undefined) {
    where.push(`${field("$.task.metadata.parentTaskId")} IS ?`);
    values.push(query.parentTaskId);
  }
  if (query.updatedAfter !== undefined) {
    where.push("task_snapshot.updated_at >= ?");
    values.push(query.updatedAfter);
  }
  if (query.updatedBefore !== undefined) {
    where.push("task_snapshot.updated_at <= ?");
    values.push(query.updatedBefore);
  }
  // package_disposition is a generated column with the active-package partial indexes. Reading
  // the JSON expression here defeats those indexes and walks archived history on every work/agenda
  // read, even though the predicate has the same meaning.
  if (query.activePackagesOnly) where.push("task_snapshot.package_disposition = 'active'");
  if (query.taskIds !== undefined) {
    where.push("task_snapshot.task_id IN (SELECT value FROM json_each(?))");
    values.push(JSON.stringify(query.taskIds));
  }
  if (query.slug !== undefined) {
    where.push(`${field("$.task.metadata.slug")} = ?`);
    values.push(query.slug);
  }
  if (query.search !== undefined) {
    where.push(
      `(lower(task_snapshot.task_id) LIKE ? ESCAPE '\\' OR lower(${field("$.task.title")}) LIKE ? ESCAPE '\\')`,
    );
    const search = query.search.toLocaleLowerCase().replace(/[\\%_]/gu, "\\$&");
    values.push(`${search}%`, `%${search}%`);
  }
  if (query.cursor !== undefined) {
    const [taskId] = decodePageCursor(query.cursor, 1);
    where.push("task_snapshot.task_id > ?");
    values.push(taskId!);
  }
  const paged = query.limit !== undefined || query.cursor !== undefined,
    limit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  if (limit !== null) values.push(limit + 1);
  const rows = queryRows<{
    readonly task_id: string;
    readonly package_path: string | null;
    readonly updated_at: string;
    readonly snapshot_json: string;
    readonly presentation_status: TaskV2["status"];
  }>(
    db,
    [
      "SELECT task_snapshot.task_id, task_package.package_path, task_snapshot.updated_at,",
      `${query.presentationStatus ? PRESENTATION_STATUS_SQL : "task_snapshot.status"} AS presentation_status, task_snapshot.snapshot_json FROM task_snapshot`,
      `LEFT JOIN task_package USING(task_id)${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
      `ORDER BY task_snapshot.task_id${limit === null ? "" : " LIMIT ?"}`,
    ].join(" "),
    ...values,
  );
  const visible = limit === null ? rows : rows.slice(0, limit),
    projected = visible.flatMap((row) => {
      let task: TaskV2 | null;
      try {
        task = (JSON.parse(row.snapshot_json) as { readonly task?: TaskV2 | null }).task ?? null;
      } catch {
        throw new Error(`projection snapshot mismatch for task ${row.task_id}`);
      }
      if (task === null) return [];
      if (validateTaskV2(task, true).length) throw new Error(`projection snapshot mismatch for task ${row.task_id}`);
      return [
        {
          taskId: row.task_id,
          supersededBy: task.supersededBy ?? null,
          title: task.title,
          status: query.presentationStatus ? row.presentation_status : task.status,
          pinned: task.pinned,
          parentTaskId: task.metadata?.parentTaskId ?? null,
          workKind: task.metadata?.workKind ?? null,
          riskTier: task.metadata?.riskTier ?? null,
          urgency: task.metadata?.urgency ?? null,
          taskClass: task.taskClass,
          packageDisposition: task.packageDisposition ?? "active",
          packagePath: row.package_path,
          updatedAt: row.updated_at,
        },
      ];
    });
  const last = projected.at(-1);
  return {
    rows: projected,
    page:
      limit === null
        ? null
        : {
            limit,
            cursor: query.cursor ?? null,
            nextCursor: rows.length > limit && last ? encodePageCursor([last.taskId]) : null,
          },
  };
}

function readTaskScopeRows(
  db: DatabaseSync,
  query: TaskProjectionListQuery,
): { readonly rows: readonly TaskIndexProjectionRow[]; readonly page: ProjectionPage | null } {
  const { scopeRootTaskId, ...unscopedQuery } = query,
    members = new Map<string, TaskIndexProjectionRow>(),
    root = readTaskIndexRows(db, {
      taskIds: [scopeRootTaskId!],
      ...(query.presentationStatus === undefined ? {} : { presentationStatus: query.presentationStatus }),
    }).rows[0];
  if (!root) return readTaskIndexRows(db, { ...unscopedQuery, taskIds: [] });

  // Page through the existing parent index. This keeps the walk proportional to the selected
  // scope; a recursive join makes SQLite scan the full parent expression index at every level.
  members.set(root.taskId, root);
  const pending = [root.taskId];
  for (let index = 0; index < pending.length; index += 1) {
    const parentTaskId = pending[index]!;
    for (const child of readTaskIndexRows(db, {
      parentTaskId,
      ...(query.presentationStatus === undefined ? {} : { presentationStatus: query.presentationStatus }),
    }).rows) {
      if (members.has(child.taskId)) continue;
      members.set(child.taskId, child);
      pending.push(child.taskId);
    }
  }

  const ancestors = new Set(members.keys());
  for (let parentTaskId = root.parentTaskId; parentTaskId !== null && !ancestors.has(parentTaskId); ) {
    const parent = readTaskIndexRows(db, {
      taskIds: [parentTaskId],
      ...(query.presentationStatus === undefined ? {} : { presentationStatus: query.presentationStatus }),
    }).rows[0];
    if (!parent) break;
    ancestors.add(parent.taskId);
    members.set(parent.taskId, parent);
    parentTaskId = parent.parentTaskId;
  }

  const memberIds = [...members.keys()],
    selectedIds =
      query.taskIds === undefined ? memberIds : memberIds.filter((taskId) => query.taskIds!.includes(taskId));
  return readTaskIndexRows(db, { ...unscopedQuery, taskIds: selectedIds });
}

/** Derive display-only creation time from the first canonical event for a task.
 * Historical migration envelopes may carry a more explicit source createdAt;
 * otherwise their occurredAt is already the source task timestamp. */
export function taskCreatedAtSql(taskIdExpression: string): string {
  return `(SELECT COALESCE(CASE WHEN json_extract(origin.event_json, '$.schema') = 'migration-import-event/v1' THEN json_extract(origin.event_json, '$.payload.createdAt') END, json_extract(origin.event_json, '$.occurredAt')) FROM event_index AS origin WHERE origin.task_id = ${taskIdExpression} ORDER BY origin.workspace_revision LIMIT 1)`;
}

/** Authoritative completion time: the occurredAt of the first task_completed transition. */
export function taskCompletedAtSql(taskIdExpression: string): string {
  return `(SELECT json_extract(completion.event_json, '$.occurredAt') FROM event_index AS completion WHERE completion.task_id = ${taskIdExpression} AND json_extract(completion.event_json, '$.schema') = 'task-event/v1' AND json_extract(completion.event_json, '$.type') = 'task_completed' ORDER BY completion.workspace_revision LIMIT 1)`;
}

/** One bounded task/runtime join. The supplied ids are filtered in memory so no
 * variable-size bind list can cross SQLite's parameter ceiling. */
export function readTaskRuntimeBatchPage(
  db: DatabaseSync,
  query: {
    readonly taskIds: readonly string[];
    readonly limit?: number;
    readonly cursor?: string;
    readonly includeSessions?: boolean;
  },
): {
  readonly taskIds: readonly string[];
  readonly rows: readonly {
    readonly taskId: string;
    readonly title: string;
    readonly packagePath: string | null;
    readonly sessions: readonly RuntimeSession[];
  }[];
  readonly page: ProjectionPage;
} {
  if (
    !Array.isArray(query.taskIds) ||
    query.taskIds.length === 0 ||
    query.taskIds.length > 500 ||
    query.taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0) ||
    new Set(query.taskIds).size !== query.taskIds.length
  )
    throw new Error("task runtime batch requires 1..500 unique task ids");
  const limit = query.limit === undefined ? 500 : checkedPageLimit(query.limit),
    ordered = [...query.taskIds].sort(),
    after = query.cursor === undefined ? null : decodePageCursor(query.cursor, 1)[0]!,
    remaining = after === null ? ordered : ordered.filter((taskId) => taskId > after),
    taskIds = remaining.slice(0, limit),
    last = taskIds.at(-1),
    encoded = JSON.stringify(taskIds);
  const taskRows = queryRows<{
    readonly task_id: string;
    readonly title: string;
    readonly package_path: string | null;
  }>(
    db,
    `WITH requested(task_order, task_id) AS MATERIALIZED (
      SELECT CAST(key AS INTEGER), value FROM json_each(?)
    )
    SELECT requested.task_id, json_extract(task_snapshot.snapshot_json, '$.task.title') AS title,
      task_package.package_path FROM requested JOIN task_snapshot USING(task_id)
    LEFT JOIN task_package USING(task_id) ORDER BY requested.task_order`,
    encoded,
  );
  const tasks = new Map(taskRows.map((row) => [row.task_id, row])),
    sessions = new Map<string, RuntimeSession[]>();
  // Label-only reads stop at the title: joining every historical binding would make a one-row
  // title lookup linear in the task's session history.
  const sessionRows =
    query.includeSessions === false
      ? []
      : queryRows<{
          readonly task_id: string;
          readonly value_json: string;
        }>(
          db,
          `WITH requested(task_order, task_id) AS MATERIALIZED (
      SELECT CAST(key AS INTEGER), value FROM json_each(?)
    )
    SELECT requested.task_id, runtime_session.value_json FROM requested
    JOIN runtime_session_task_binding USING(task_id) JOIN runtime_session USING(runtime_session_id)
    ORDER BY requested.task_order, runtime_session.runtime_session_id,
      runtime_session_task_binding.bound_at, runtime_session_task_binding.execution_id`,
          encoded,
        );
  for (const row of sessionRows) {
    const values = sessions.get(row.task_id) ?? [];
    values.push(publicRuntimeSession(JSON.parse(row.value_json) as RuntimeSession));
    sessions.set(row.task_id, values);
  }
  return {
    taskIds,
    rows: taskIds.flatMap((taskId) => {
      const task = tasks.get(taskId);
      return task
        ? [{ taskId, title: task.title, packagePath: task.package_path, sessions: sessions.get(taskId) ?? [] }]
        : [];
    }),
    page: {
      limit,
      cursor: query.cursor ?? null,
      nextCursor: remaining.length > limit && last ? encodePageCursor([last]) : null,
    },
  };
}

/** One task's progress events in revision order; the shared body of every progress read. */
export function readTaskProgressRows(db: DatabaseSync, taskId: string): readonly TaskProgressEventV1[] {
  return queryRows<{ readonly event_json: string }>(
    db,
    "SELECT event_json FROM task_progress WHERE task_id = ? ORDER BY workspace_revision",
    taskId,
  ).map((row) => JSON.parse(String(row.event_json)) as TaskProgressEventV1);
}

export function createTaskRelationProjectionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_relation (relation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL,
      direction TEXT NOT NULL, strength TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, rationale TEXT NOT NULL, owner_ref TEXT NOT NULL,
      source_path TEXT NOT NULL, record_index INTEGER NOT NULL, workspace_revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_relation_source ON task_relation(source_ref, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_target ON task_relation(target_ref, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_type_source ON task_relation(relation_type, source_ref, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_type_target ON task_relation(relation_type, target_ref, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_type ON task_relation(relation_type, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_updated ON task_relation(updated_at DESC, relation_id ASC);
    CREATE INDEX IF NOT EXISTS task_relation_task ON task_relation(task_id, relation_id);
  `);
}

/** Rebuild the task-local lookup index strictly from the canonical Relation projection. */
export function refreshTaskRelationProjection(
  db: DatabaseSync,
  taskId: string,
  _task: TaskV2 | null,
  _revision: number,
  updatedAt: string,
  _packagePath?: string | null,
): void {
  prepareQuery(db, "DELETE FROM task_relation WHERE task_id = ?").run(taskId);
  prepareQuery(
    db,
    [
      "INSERT INTO task_relation(relation_id, task_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index, workspace_revision, updated_at)",
      "SELECT relation_id, ?, source_ref, target_ref, relation_type,",
      "json_extract(row_json, '$.direction'), json_extract(row_json, '$.strength'),",
      "json_extract(row_json, '$.origin'), state, json_extract(row_json, '$.rationale'), owner_ref,",
      "json_extract(row_json, '$.sourcePath'), json_extract(row_json, '$.recordIndex'), workspace_revision,",
      "COALESCE(json_extract(row_json, '$.entity.updatedAt'), ?)",
      "FROM relation_edge WHERE source_ref=?",
    ].join(" "),
  ).run(taskId, updatedAt, `task/${taskId}`);
}

/** Every task-owned edge, ordered by relation id — the event-side task rows of the converged relation graph. */
export function readTaskRelationRows(db: DatabaseSync): readonly TaskRelationProjectionRow[] {
  return storedTaskRelationRows(
    queryRows(
      db,
      [
        "SELECT task_relation.relation_id, task_relation.source_ref, task_relation.target_ref,",
        "task_relation.relation_type, task_relation.direction, task_relation.strength, task_relation.origin,",
        "task_relation.state, relation_edge.target_observed_version, task_relation.rationale,",
        "task_relation.owner_ref, task_relation.source_path, task_relation.record_index,",
        "relation_edge.workspace_revision AS relation_revision, relation_edge.freshness,",
        "relation_edge.current_target_version",
        "FROM task_relation JOIN relation_edge USING(relation_id) ORDER BY task_relation.relation_id",
      ].join(" "),
    ),
  );
}

/** One indexed lookup for every requested target. json_each keeps the statement shape and
 * bind count fixed even when a caller supplies more than SQLite's variable ceiling. */
export function readTaskRelationsByTargets(
  db: DatabaseSync,
  targetRefs: readonly string[],
  relationType: string,
): readonly TaskRelationProjectionRow[] {
  return readTaskRelationsByEndpoint(db, "target", targetRefs, relationType);
}

/** The same indexed lookup keyed by source endpoint (e.g. the `awaits` edges a task page holds). */
export function readTaskRelationsBySources(
  db: DatabaseSync,
  sourceRefs: readonly string[],
  relationType: string,
): readonly TaskRelationProjectionRow[] {
  return readTaskRelationsByEndpoint(db, "source", sourceRefs, relationType);
}

function readTaskRelationsByEndpoint(
  db: DatabaseSync,
  endpoint: "source" | "target",
  refs: readonly string[],
  relationType: string,
): readonly TaskRelationProjectionRow[] {
  checkedRefs(refs, `relation ${endpoint} batch`);
  if (refs.length === 0) return [];
  const sql = `WITH requested_refs(ref_order, ref) AS MATERIALIZED (SELECT CAST(key AS INTEGER), value FROM json_each(?)),
    matching_rows AS (
      SELECT requested_refs.ref_order, relation_edge.relation_id, relation_edge.source_ref,
        relation_edge.target_ref, relation_edge.relation_type,
        json_extract(relation_edge.row_json, '$.direction') AS direction,
        json_extract(relation_edge.row_json, '$.strength') AS strength,
        json_extract(relation_edge.row_json, '$.origin') AS origin,
        relation_edge.state, relation_edge.target_observed_version,
        json_extract(relation_edge.row_json, '$.rationale') AS rationale, relation_edge.owner_ref,
        json_extract(relation_edge.row_json, '$.sourcePath') AS source_path,
        json_extract(relation_edge.row_json, '$.recordIndex') AS record_index,
        relation_edge.workspace_revision AS relation_revision, relation_edge.freshness, relation_edge.current_target_version
      FROM requested_refs CROSS JOIN relation_edge INDEXED BY relation_edge_type_${endpoint}
      WHERE relation_edge.${endpoint}_ref = requested_refs.ref AND relation_edge.relation_type = ?
    )
    SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state,
      target_observed_version, rationale, owner_ref, source_path, record_index, relation_revision,
      freshness, current_target_version
    FROM matching_rows ORDER BY ref_order, relation_id`;
  return storedTaskRelationRows(queryRows(db, sql, JSON.stringify(refs), relationType));
}

/** Indexed, cycle-safe graph neighborhood. The node budget fails closed; the depth
 * boundary is reported on the window so read views can mark the frontier instead of
 * silently pretending it is complete. Callers that need the historical fail-closed
 * contract keep using readTaskRelationNeighborhoodRows. */
export function readTaskRelationNeighborhoodWindow(
  db: DatabaseSync,
  query: TaskRelationNeighborhoodQuery,
): TaskRelationNeighborhoodWindow {
  checkedRefs([query.seed], "relation neighborhood seed");
  if (query.relationTypes.length === 0) throw new Error("relation neighborhood types requires at least one ref");
  checkedRefs(query.relationTypes, "relation neighborhood types");
  if (!Number.isSafeInteger(query.maxDepth) || query.maxDepth < 1 || query.maxDepth > 4_096)
    throw new Error("relation neighborhood depth limit must be an integer between 1 and 4096");
  if (!Number.isSafeInteger(query.maxNodes) || query.maxNodes < 1 || query.maxNodes > 10_000)
    throw new Error("relation neighborhood node budget must be an integer between 1 and 10000");
  const outgoing = query.direction === "outgoing" || query.direction === "both",
    incoming = query.direction === "incoming" || query.direction === "both";
  if (!outgoing && !incoming) throw new Error("relation neighborhood direction is invalid");
  const state = query.state ?? null,
    types = JSON.stringify(query.relationTypes),
    arms = [
      ...(outgoing
        ? [
            `SELECT edge.target_ref, walk.depth + 1, walk.visited_path || edge.target_ref || char(31), edge.relation_id
        FROM walk CROSS JOIN relation_edge AS edge INDEXED BY relation_edge_source
        WHERE edge.source_ref = walk.ref AND edge.relation_type IN (SELECT value FROM json_each(?))
          AND (? IS NULL OR edge.state = ?) AND walk.depth < ?
          AND instr(walk.visited_path, char(31) || edge.target_ref || char(31)) = 0`,
          ]
        : []),
      ...(incoming
        ? [
            `SELECT edge.source_ref, walk.depth + 1, walk.visited_path || edge.source_ref || char(31), edge.relation_id
        FROM walk CROSS JOIN relation_edge AS edge INDEXED BY relation_edge_target
        WHERE edge.target_ref = walk.ref AND edge.relation_type IN (SELECT value FROM json_each(?))
          AND (? IS NULL OR edge.state = ?) AND walk.depth < ?
          AND instr(walk.visited_path, char(31) || edge.source_ref || char(31)) = 0`,
          ]
        : []),
    ],
    parameters: (string | number | null)[] = [query.seed];
  for (let index = 0; index < arms.length; index += 1) parameters.push(types, state, state, query.maxDepth);
  const boundaryPredicates = [
      ...(outgoing ? ["edge.source_ref = walk.ref"] : []),
      ...(incoming ? ["edge.target_ref = walk.ref"] : []),
    ].join(" OR "),
    nextRef =
      outgoing && incoming
        ? "CASE WHEN edge.source_ref = walk.ref THEN edge.target_ref ELSE edge.source_ref END"
        : outgoing
          ? "edge.target_ref"
          : "edge.source_ref",
    sql = `WITH RECURSIVE walk(ref, depth, visited_path, relation_id) AS (
      SELECT ?, 0, char(31) || ? || char(31), NULL
      UNION ALL ${arms.join(" UNION ALL ")}
    ), nodes AS (SELECT DISTINCT ref FROM walk), overflow AS (
      SELECT 1 AS present FROM walk CROSS JOIN relation_edge AS edge
      WHERE walk.depth = ? AND (${boundaryPredicates})
        AND edge.relation_type IN (SELECT value FROM json_each(?)) AND (? IS NULL OR edge.state = ?)
        AND instr(walk.visited_path, char(31) || ${nextRef} || char(31)) = 0 LIMIT 1
    )
    SELECT edge.relation_id, edge.source_ref, edge.target_ref, edge.relation_type,
      json_extract(row_json, '$.direction') AS direction, json_extract(row_json, '$.strength') AS strength,
      json_extract(row_json, '$.origin') AS origin, edge.state, target_observed_version,
      json_extract(row_json, '$.rationale') AS rationale, edge.owner_ref,
      json_extract(row_json, '$.sourcePath') AS source_path, json_extract(row_json, '$.recordIndex') AS record_index,
      edge.freshness, edge.current_target_version,
      (SELECT count(*) FROM nodes) AS node_count, EXISTS(SELECT 1 FROM overflow) AS depth_overflow
    FROM relation_edge AS edge WHERE edge.relation_id IN (SELECT relation_id FROM walk WHERE relation_id IS NOT NULL)
    UNION ALL
    SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      (SELECT count(*) FROM nodes), EXISTS(SELECT 1 FROM overflow)
    ORDER BY relation_id`;
  parameters.unshift(query.seed);
  parameters.push(query.maxDepth, types, state, state);
  const records = queryRows<ProjectionSqlRow & { readonly node_count: number; readonly depth_overflow: number }>(
    db,
    sql,
    ...parameters,
  );
  const nodeCount = records[0]?.node_count ?? 1;
  if (nodeCount > query.maxNodes) throw new Error(`relation neighborhood node budget ${query.maxNodes} exceeded`);
  return {
    rows: storedTaskRelationRows(records.filter((record) => record.relation_id !== null)),
    truncated: records[0]?.depth_overflow === 1,
  };
}

export function readTaskRelationNeighborhoodRows(
  db: DatabaseSync,
  query: TaskRelationNeighborhoodQuery,
): readonly TaskRelationProjectionRow[] {
  const window = readTaskRelationNeighborhoodWindow(db, query);
  if (window.truncated) throw new Error(`relation neighborhood depth limit ${query.maxDepth} exceeded`);
  return window.rows;
}

/** Indexed transitive depends-on read. The path token prevents cycles from being traversed,
 * while the explicit depth cap fails instead of silently serving a truncated blocker set. */
export function readTaskDependencyClosureRows(
  db: DatabaseSync,
  sourceRefs: readonly string[],
  maxDepth = 256,
): readonly TaskRelationProjectionRow[] {
  checkedRefs(sourceRefs, "dependency closure");
  if (sourceRefs.length === 0) return [];
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 4_096)
    throw new Error("dependency closure depth limit must be an integer between 1 and 4096");
  const sql = `WITH RECURSIVE dependency_walk(seed_order, source_ref, depth, visited_path) AS (
      SELECT CAST(key AS INTEGER), value, 0, char(31) || value || char(31) FROM json_each(?)
      UNION ALL
      SELECT dependency_walk.seed_order, relation_edge.target_ref, dependency_walk.depth + 1, dependency_walk.visited_path || relation_edge.target_ref || char(31)
      FROM dependency_walk CROSS JOIN relation_edge INDEXED BY relation_edge_source
      WHERE relation_edge.source_ref = dependency_walk.source_ref AND relation_edge.relation_type = 'depends-on' AND dependency_walk.depth < ?
        AND instr(dependency_walk.visited_path, char(31) || relation_edge.target_ref || char(31)) = 0
    ), dependency_rows AS (
      SELECT dependency_walk.seed_order, dependency_walk.depth, dependency_walk.visited_path,
        relation_edge.relation_id, relation_edge.source_ref, relation_edge.target_ref, relation_edge.relation_type,
        json_extract(relation_edge.row_json, '$.direction') AS direction,
        json_extract(relation_edge.row_json, '$.strength') AS strength,
        json_extract(relation_edge.row_json, '$.origin') AS origin,
        relation_edge.state, relation_edge.target_observed_version,
        json_extract(relation_edge.row_json, '$.rationale') AS rationale, relation_edge.owner_ref,
        json_extract(relation_edge.row_json, '$.sourcePath') AS source_path,
        json_extract(relation_edge.row_json, '$.recordIndex') AS record_index,
        relation_edge.freshness, relation_edge.current_target_version
      FROM dependency_walk CROSS JOIN relation_edge INDEXED BY relation_edge_source
      WHERE relation_edge.source_ref = dependency_walk.source_ref AND relation_edge.relation_type = 'depends-on'
    ), dependency_overflow AS (
      SELECT 1 AS present FROM dependency_walk CROSS JOIN relation_edge INDEXED BY relation_edge_source
      WHERE relation_edge.source_ref = dependency_walk.source_ref AND dependency_walk.depth = ? AND relation_edge.relation_type = 'depends-on'
        AND instr(dependency_walk.visited_path, char(31) || relation_edge.target_ref || char(31)) = 0
      LIMIT 1
    )
    SELECT 0 AS overflow, seed_order, depth, visited_path, relation_id, source_ref, target_ref, relation_type,
      direction, strength, origin, state, target_observed_version, rationale, owner_ref, source_path, record_index,
      freshness, current_target_version
    FROM dependency_rows
    UNION ALL
    SELECT 1, -1, -1, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    FROM dependency_overflow
    ORDER BY overflow DESC, depth, seed_order, visited_path, relation_id`;
  const records = queryRows<ProjectionSqlRow & { readonly overflow: number }>(
    db,
    sql,
    JSON.stringify(sourceRefs),
    maxDepth,
    maxDepth,
  );
  if (records[0]?.overflow === 1) throw new Error(`dependency closure depth limit ${maxDepth} exceeded`);
  const rows = new Map<string, TaskRelationProjectionRow>();
  for (const row of storedTaskRelationRows(records.filter((record) => record.relation_id !== null)))
    if (!rows.has(row.relationId)) rows.set(row.relationId, row);
  return [...rows.values()];
}

/** Cheap id+status pairs from the maintained columns — the blocking judgment's task input
 * without materializing any snapshot JSON. */
export function readTaskStatusRows(
  db: DatabaseSync,
  taskIds?: readonly string[],
): readonly { readonly taskId: string; readonly status: string | null }[] {
  if (taskIds?.length === 0) return [];
  // Keep one fixed statement and one bind regardless of dependency-closure size. json_each
  // preserves the primary-key lookup shape without crossing SQLite's variable limit or
  // falling back to a full task_snapshot scan on large ledgers.
  const scoped = taskIds !== undefined;
  const sql = scoped
    ? "SELECT task_id, status FROM task_snapshot WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id"
    : "SELECT task_id, status FROM task_snapshot ORDER BY task_id";
  return queryRows<{ readonly task_id: string; readonly status: string | null }>(
    db,
    sql,
    ...(scoped ? [JSON.stringify(taskIds)] : []),
  ).map((row) => ({ taskId: row.task_id, status: row.status }));
}

/** Indexed existence check used by task creation and parent validation.
 * The task_snapshot primary key keeps this lookup bounded. */
export function readTaskExists(db: DatabaseSync, taskId: string): boolean {
  const query = "SELECT task_id FROM task_snapshot WHERE task_id = ? LIMIT 1";
  return queryRows<{ readonly task_id: string }>(db, query, taskId).length > 0;
}

/** Find a task by its idempotency key without materializing the task index. */
export function readTaskByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string,
): { readonly taskId: string; readonly status: string; readonly packagePath: string | null } | null {
  const row = queryRows<{
    readonly task_id: string;
    readonly status: string;
    readonly package_path: string | null;
  }>(
    db,
    [
      "SELECT task_snapshot.task_id, task_snapshot.status, task_package.package_path FROM task_snapshot",
      "LEFT JOIN task_package USING(task_id)",
      "WHERE json_extract(task_snapshot.snapshot_json, '$.task.metadata.idempotencyKey') = ? LIMIT 1",
    ].join(" "),
    idempotencyKey,
  )[0];
  return row ? { taskId: row.task_id, status: row.status, packagePath: row.package_path } : null;
}

/** Indexed narrow page over the task snapshot table; order matches the unparameterized list (task id asc). */
export function listTaskRowsNarrow(
  db: DatabaseSync,
  query: TaskProjectionListQuery,
): { readonly rows: readonly NarrowTaskRow[]; readonly page: ProjectionPage | null } {
  const values: (string | number)[] = [],
    where: string[] = [];
  if (query.status !== undefined) {
    where.push(`${query.presentationStatus ? PRESENTATION_STATUS_SQL : "task_snapshot.status"} = ?`);
    values.push(query.status);
  }
  if (query.changedAfterRevision !== undefined) {
    where.push("task_snapshot.workspace_revision > ?");
    values.push(query.changedAfterRevision);
  }
  if (query.updatedAfter !== undefined) {
    where.push("task_snapshot.updated_at >= ?");
    values.push(query.updatedAfter);
  }
  if (query.updatedBefore !== undefined) {
    where.push("task_snapshot.updated_at <= ?");
    values.push(query.updatedBefore);
  }
  if (query.activePackagesOnly) where.push("task_snapshot.package_disposition = 'active'");
  // One JSON bind carries the whole membership set, so no variable-size bind list can cross
  // SQLite's parameter ceiling (the same reason readTaskChildCounts batches via json_each).
  if (query.taskIds !== undefined) {
    where.push("task_snapshot.task_id IN (SELECT value FROM json_each(?))");
    values.push(JSON.stringify(query.taskIds));
  }
  if (query.cursor !== undefined) {
    if (query.pinnedFirst) {
      const [pinned, taskId] = decodePageCursor(query.cursor, 2);
      if (pinned !== "0" && pinned !== "1") throw new Error("query cursor is invalid");
      where.push("(task_snapshot.pinned < ? OR (task_snapshot.pinned = ? AND task_snapshot.task_id > ?))");
      values.push(Number(pinned), Number(pinned), taskId!);
    } else {
      const [taskId] = decodePageCursor(query.cursor, 1);
      where.push("task_snapshot.task_id > ?");
      values.push(taskId!);
    }
  }
  const leaseJoin = query.leaseOnly
      ? " JOIN (SELECT DISTINCT task_id FROM lease_interval WHERE released_revision IS NULL AND task_active = 1) lease_task ON lease_task.task_id = task_snapshot.task_id"
      : "",
    paged = query.limit !== undefined || query.cursor !== undefined,
    pageLimit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  const sql = `SELECT task_snapshot.task_id AS task_id, task_package.package_path AS package_path, COALESCE(task_generation.generation, 'v1') AS generation, task_snapshot.workspace_revision AS workspace_revision, ${taskCreatedAtSql("task_snapshot.task_id")} AS created_at, ${taskCompletedAtSql("task_snapshot.task_id")} AS completed_at, task_snapshot.updated_at AS updated_at, task_snapshot.pinned AS pinned, ${query.presentationStatus ? PRESENTATION_STATUS_SQL : "task_snapshot.status"} AS presentation_status FROM task_snapshot LEFT JOIN task_package USING(task_id) LEFT JOIN task_generation USING(task_id)${leaseJoin}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${query.pinnedFirst ? "task_snapshot.pinned DESC, " : ""}task_snapshot.task_id${pageLimit === null ? "" : " LIMIT ?"}`;
  if (pageLimit !== null) values.push(pageLimit + 1);
  const raw = queryRows<NarrowTaskRow & ProjectionSqlRow>(db, sql, ...values),
    visible = pageLimit === null ? raw : raw.slice(0, pageLimit);
  if (pageLimit === null) return { rows: visible, page: null };
  const last = visible.at(-1);
  return {
    rows: visible,
    page: {
      limit: pageLimit,
      cursor: query.cursor ?? null,
      nextCursor:
        raw.length > pageLimit && last
          ? encodePageCursor(query.pinnedFirst ? [String(last.pinned), last.task_id] : [last.task_id])
          : null,
    },
  };
}

/**
 * Narrow page over the projected relation edges. Every task-owned lookup row is derived
 * from `relation_edge`, so the edge table alone carries the stored freshness the page
 * filters and returns.
 */
export function readTaskRelationPage(
  db: DatabaseSync,
  query: TaskRelationQuery,
): { readonly rows: readonly TaskRelationProjectionRow[]; readonly page: ProjectionPage | null } {
  const eventRows = [
    "SELECT relation_id, source_ref, target_ref, relation_type,",
    "json_extract(row_json, '$.direction') AS direction,",
    "json_extract(row_json, '$.strength') AS strength,",
    "json_extract(row_json, '$.origin') AS origin, state, target_observed_version,",
    "json_extract(row_json, '$.rationale') AS rationale, owner_ref,",
    "json_extract(row_json, '$.sourcePath') AS source_path,",
    "json_extract(row_json, '$.recordIndex') AS record_index, workspace_revision,",
    "workspace_revision AS relation_revision, updated_at, freshness, current_target_version",
    "FROM relation_edge",
  ].join(" ");
  // With an endpoint fixed, its source or target index finds that endpoint's few edges. Unary +
  // keeps the type and state filters from steering SQLite to their own indexes instead, which
  // visit every edge of that type or state in the repository.
  const residual = query.entity !== undefined || query.source !== undefined || query.target !== undefined ? "+" : "",
    where: string[] = [],
    values: (string | number)[] = [];
  if (query.entity !== undefined) {
    // The entity's own edges plus its sub-refs (`decision/<id>/<claim>`). Range compares on the
    // `entity/` prefix keep the source/target indexes driving the read; LIKE would not.
    where.push(
      "(source_ref = ? OR target_ref = ? OR (source_ref >= ? AND source_ref < ?) OR (target_ref >= ? AND target_ref < ?))",
    );
    values.push(
      query.entity,
      query.entity,
      `${query.entity}/`,
      `${query.entity}0`,
      `${query.entity}/`,
      `${query.entity}0`,
    );
  }
  if (query.source !== undefined) {
    where.push("source_ref = ?");
    values.push(query.source);
  }
  if (query.target !== undefined) {
    where.push("target_ref = ?");
    values.push(query.target);
  }
  if (query.relationType !== undefined) {
    where.push(`${residual}relation_type = ?`);
    values.push(query.relationType);
  }
  if (query.state !== undefined) {
    where.push(`${residual}state = ?`);
    values.push(query.state);
  }
  if (query.direction !== undefined) {
    where.push("direction = ?");
    values.push(query.direction);
  }
  if (query.ownerRef !== undefined) {
    where.push("owner_ref = ?");
    values.push(query.ownerRef);
  }
  if (query.updatedAfter !== undefined) {
    where.push("updated_at >= ?");
    values.push(query.updatedAfter);
  }
  if (query.updatedBefore !== undefined) {
    where.push("updated_at <= ?");
    values.push(query.updatedBefore);
  }
  // Freshness is the relation's stored global value (dec_E34C4284B48AFAF152D7BF1980), so the filter
  // is one more column predicate served by relation_edge_freshness_page.
  if (query.freshness !== undefined) {
    where.push("freshness = ?");
    values.push(query.freshness);
  }
  if (query.cursor !== undefined) {
    const [relationId] = decodePageCursor(query.cursor, 1);
    where.push("relation_id > ?");
    values.push(relationId!);
  }
  const paged = query.limit !== undefined || query.cursor !== undefined,
    pageLimit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  // Anchor the primary-key range even on the first page so SQLite can stop each
  // source after limit plus one rows instead of treating it as a table scan.
  if (pageLimit !== null && query.cursor === undefined) {
    where.push("relation_id >= ?");
    values.push("");
  }
  const sqlLimitBind = pageLimit === null ? null : pageLimit + 1;
  let sql: string;
  let sqlValues: (string | number)[];
  if (sqlLimitBind !== null) {
    const predicate = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    sql = `SELECT * FROM (${eventRows})${predicate} ORDER BY relation_id LIMIT ?`;
    sqlValues = [...values, sqlLimitBind];
  } else {
    sql = [
      `SELECT * FROM (${eventRows})`,
      where.length ? ` WHERE ${where.join(" AND ")}` : "",
      " ORDER BY relation_id",
    ].join("");
    sqlValues = [...values];
  }
  const filtered = storedTaskRelationRows(queryRows(db, sql, ...sqlValues)),
    rows = pageLimit === null ? filtered : filtered.slice(0, pageLimit);
  if (pageLimit === null) return { rows, page: null };
  const last = rows.at(-1);
  return {
    rows,
    page: {
      limit: pageLimit,
      cursor: query.cursor ?? null,
      nextCursor: filtered.length > pageLimit && last ? encodePageCursor([last.relationId]) : null,
    },
  };
}

/**
 * Read-only stock audit over every projected relation edge. This is the projection layer's
 * adapter to the one typed-cycle algorithm; it never writes and is only called from rebuild
 * and doctor, never from a write or hot read path.
 */
export function auditRelationCycles(db: DatabaseSync): RelationCycleAudit {
  return readRelationCycleAudit(db);
}

/** Task relation rows with the freshness stored on relation_edge at their last write cut. */
function storedTaskRelationRows(rows: readonly Record<string, unknown>[]): readonly TaskRelationProjectionRow[] {
  return rows.map(taskRelationRow);
}

function taskRelationRow(row: Record<string, unknown>): TaskRelationProjectionRow {
  const relationId = String(row.relation_id),
    relationType = String(row.relation_type) as TaskRelationProjectionRow["relationType"],
    targetObservedVersion =
      typeof row.target_observed_version === "string" || typeof row.target_observed_version === "number"
        ? row.target_observed_version
        : null;
  if (!isRelationFreshness(row.freshness)) throw new Error(`relation ${relationId} has no stored freshness`);
  return {
    relationId,
    workspaceRevision: typeof row.relation_revision === "number" ? row.relation_revision : null,
    sourceRef: String(row.source_ref),
    targetRef: String(row.target_ref),
    relationType,
    direction: String(row.direction) as TaskRelationProjectionRow["direction"],
    strength: String(row.strength) as TaskRelationProjectionRow["strength"],
    origin: String(row.origin) as TaskRelationProjectionRow["origin"],
    state: String(row.state) as TaskRelationProjectionRow["state"],
    targetObservedVersion,
    currentTargetVersion:
      typeof row.current_target_version === "string" || typeof row.current_target_version === "number"
        ? row.current_target_version
        : null,
    freshness: row.freshness,
    rationale: String(row.rationale ?? ""),
    ownerRef: String(row.owner_ref),
    sourcePath: String(row.source_path),
    recordIndex: Number(row.record_index),
  };
}

function checkedRefs(refs: readonly string[], label: string): void {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || ref.length === 0))
    throw new Error(`${label} requires non-empty string refs`);
}

export function checkedPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500)
    throw new Error("query page limit must be an integer between 1 and 500");
  return value;
}
export function encodePageCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}
export function decodePageCursor(value: string, expected: number): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("query cursor is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expected ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("query cursor is invalid");
  return parsed;
}
