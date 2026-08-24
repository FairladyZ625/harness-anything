// No @write-boundary-exemption marker is needed here: this module never opens a
// database itself — it receives the already-open rebuildable projection handle
// from rebuildable-task-projection.ts, which owns the governed writable open.
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSession } from "../domain/agent-runtime.ts";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { ReplayTaskStatus, TaskV1 } from "../domain/task.ts";

/**
 * Narrow-query companions for the rebuildable task projection. Everything here
 * reads or maintains disposable derived tables inside task.sqlite; the
 * authoritative source stays the canonical event stream, and every write flows
 * through the projection's own transaction (apply/rebuild/cold catch-up).
 */
export interface ProjectionPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}
export interface TaskProjectionListQuery {
  readonly status?: ReplayTaskStatus;
  readonly changedAfterRevision?: number;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly pinnedFirst?: boolean;
}
export interface TaskRelationQuery {
  readonly entity?: string;
  readonly source?: string;
  readonly target?: string;
  readonly relationType?: string;
  readonly state?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export interface TaskRelationProjectionRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}
export interface NarrowTaskRow {
  readonly task_id: string;
  readonly package_path: string | null;
  readonly generation: "v0" | "v1";
  readonly workspace_revision: number;
  readonly created_at: string | null;
  readonly updated_at: string;
  readonly pinned: number;
}

/** Derive display-only creation time from the first canonical event for a task.
 * Historical migration envelopes may carry a more explicit source createdAt;
 * otherwise their occurredAt is already the source task timestamp. */
export function taskCreatedAtSql(taskIdExpression: string): string {
  return `(SELECT COALESCE(CASE WHEN json_extract(origin.event_json, '$.schema') = 'migration-import-event/v1' THEN json_extract(origin.event_json, '$.payload.createdAt') END, json_extract(origin.event_json, '$.occurredAt')) FROM event_index AS origin WHERE origin.task_id = ${taskIdExpression} ORDER BY origin.workspace_revision LIMIT 1)`;
}

/** One bounded task/runtime join. The supplied ids are filtered in memory so no
 * variable-size bind list can cross SQLite's parameter ceiling. */
export function readTaskRuntimeBatchPage(
  db: DatabaseSync,
  query: { readonly taskIds: readonly string[]; readonly limit?: number; readonly cursor?: string },
): {
  readonly taskIds: readonly string[];
  readonly rows: readonly {
    readonly taskId: string;
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
  const taskRows = db
    .prepare(
      `WITH requested(task_order, task_id) AS MATERIALIZED (
      SELECT CAST(key AS INTEGER), value FROM json_each(?)
    )
    SELECT requested.task_id, task_package.package_path FROM requested JOIN task_snapshot USING(task_id)
    LEFT JOIN task_package USING(task_id) ORDER BY requested.task_order`,
    )
    .all(encoded) as unknown as readonly {
    readonly task_id: string;
    readonly package_path: string | null;
  }[];
  const tasks = new Map(taskRows.map((row) => [row.task_id, row])),
    sessions = new Map<string, RuntimeSession[]>();
  const sessionRows = db
    .prepare(
      `WITH requested(task_order, task_id) AS MATERIALIZED (
      SELECT CAST(key AS INTEGER), value FROM json_each(?)
    )
    SELECT requested.task_id, runtime_session.value_json FROM requested
    JOIN runtime_session_task_binding USING(task_id) JOIN runtime_session USING(runtime_session_id)
    ORDER BY requested.task_order, runtime_session.runtime_session_id,
      runtime_session_task_binding.bound_at, runtime_session_task_binding.execution_id`,
    )
    .all(encoded) as unknown as readonly {
    readonly task_id: string;
    readonly value_json: string;
  }[];
  for (const row of sessionRows) {
    const values = sessions.get(row.task_id) ?? [];
    values.push(JSON.parse(row.value_json) as RuntimeSession);
    sessions.set(row.task_id, values);
  }
  return {
    taskIds,
    rows: taskIds.flatMap((taskId) => {
      const task = tasks.get(taskId);
      return task ? [{ taskId, packagePath: task.package_path, sessions: sessions.get(taskId) ?? [] }] : [];
    }),
    page: {
      limit,
      cursor: query.cursor ?? null,
      nextCursor: remaining.length > limit && last ? encodePageCursor([last]) : null,
    },
  };
}

export function createTaskRelationProjectionTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_relation (relation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_ref TEXT NOT NULL, target_ref TEXT NOT NULL, relation_type TEXT NOT NULL,
      direction TEXT NOT NULL, strength TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, rationale TEXT NOT NULL, owner_ref TEXT NOT NULL,
      source_path TEXT NOT NULL, record_index INTEGER NOT NULL, workspace_revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_relation_source ON task_relation(source_ref, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_target ON task_relation(target_ref, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_type ON task_relation(relation_type, state, relation_id);
    CREATE INDEX IF NOT EXISTS task_relation_updated ON task_relation(updated_at DESC, relation_id ASC);
  `);
}

/**
 * Replace one task's projected relation rows with the records its current
 * snapshot declares. The rows are byte-equal to what the wide relation graph
 * read used to derive by materializing every task snapshot and flat-mapping
 * `task.relations`, so the projection table is a cache of that exact shape.
 */
export function refreshTaskRelationProjection(
  db: DatabaseSync,
  taskId: string,
  task: TaskV1 | null,
  revision: number,
  updatedAt: string,
  packagePath?: string | null,
): void {
  db.prepare("DELETE FROM task_relation WHERE task_id = ?").run(taskId);
  if (!task?.relations?.length) return;
  const resolvedPackagePath =
    packagePath ??
    (
      db.prepare("SELECT package_path FROM task_package WHERE task_id = ?").get(taskId) as
        | { readonly package_path: string }
        | undefined
    )?.package_path ??
    `harness/tasks/${taskId}`;
  const ownerRef = `task/${taskId}`,
    sourcePath = `${resolvedPackagePath}/INDEX.md`;
  const insert = db.prepare(
    "INSERT OR REPLACE INTO task_relation(relation_id, task_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index, workspace_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const [recordIndex, relation] of task.relations.entries())
    insert.run(
      relation.relation_id,
      taskId,
      relation.source,
      relation.target,
      relation.type,
      relation.direction,
      relation.strength,
      relation.origin,
      relation.state,
      relation.rationale,
      ownerRef,
      sourcePath,
      recordIndex,
      revision,
      updatedAt,
    );
}

/** Every task-owned edge, ordered by relation id — the event-side task rows of the converged relation graph. */
export function readTaskRelationRows(db: DatabaseSync): readonly TaskRelationProjectionRow[] {
  return (
    db
      .prepare(
        "SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index FROM task_relation ORDER BY relation_id",
      )
      .all() as unknown as readonly Record<string, unknown>[]
  ).map(taskRelationRow);
}

/** One indexed lookup for every requested target. json_each keeps the statement shape and
 * bind count fixed even when a caller supplies more than SQLite's variable ceiling. */
export function readTaskRelationsByTargets(
  db: DatabaseSync,
  targetRefs: readonly string[],
  relationType: string,
): readonly TaskRelationProjectionRow[] {
  checkedRefs(targetRefs, "relation target batch");
  if (targetRefs.length === 0) return [];
  const sql = `WITH requested_targets(target_order, target_ref) AS MATERIALIZED (SELECT CAST(key AS INTEGER), value FROM json_each(?)),
    matching_rows AS (
      SELECT requested_targets.target_order, task_relation.relation_id, task_relation.source_ref, task_relation.target_ref, task_relation.relation_type, task_relation.direction, task_relation.strength, task_relation.origin, task_relation.state, task_relation.rationale, task_relation.owner_ref, task_relation.source_path, task_relation.record_index
      FROM requested_targets CROSS JOIN task_relation INDEXED BY task_relation_target
      WHERE task_relation.target_ref = requested_targets.target_ref AND task_relation.relation_type = ? AND NOT EXISTS (SELECT 1 FROM relation_edge WHERE relation_edge.relation_id = task_relation.relation_id)
      UNION ALL
      SELECT requested_targets.target_order, relation_edge.relation_id, relation_edge.source_ref, relation_edge.target_ref, relation_edge.relation_type, json_extract(relation_edge.row_json, '$.direction'), json_extract(relation_edge.row_json, '$.strength'), json_extract(relation_edge.row_json, '$.origin'), relation_edge.state, json_extract(relation_edge.row_json, '$.rationale'), relation_edge.owner_ref, json_extract(relation_edge.row_json, '$.sourcePath'), json_extract(relation_edge.row_json, '$.recordIndex')
      FROM requested_targets CROSS JOIN relation_edge INDEXED BY relation_edge_target
      WHERE relation_edge.target_ref = requested_targets.target_ref AND relation_edge.relation_type = ?
    )
    SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index FROM matching_rows ORDER BY target_order, relation_id`;
  return (
    db.prepare(sql).all(JSON.stringify(targetRefs), relationType, relationType) as unknown as readonly Record<
      string,
      unknown
    >[]
  ).map(taskRelationRow);
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
      SELECT dependency_walk.seed_order, task_relation.target_ref, dependency_walk.depth + 1, dependency_walk.visited_path || task_relation.target_ref || char(31)
      FROM dependency_walk CROSS JOIN task_relation INDEXED BY task_relation_source
      WHERE task_relation.source_ref = dependency_walk.source_ref AND task_relation.relation_type = 'depends-on' AND dependency_walk.depth < ?
        AND NOT EXISTS (SELECT 1 FROM relation_edge WHERE relation_edge.relation_id = task_relation.relation_id)
        AND instr(dependency_walk.visited_path, char(31) || task_relation.target_ref || char(31)) = 0
      UNION ALL
      SELECT dependency_walk.seed_order, relation_edge.target_ref, dependency_walk.depth + 1, dependency_walk.visited_path || relation_edge.target_ref || char(31)
      FROM dependency_walk CROSS JOIN relation_edge INDEXED BY relation_edge_source
      WHERE relation_edge.source_ref = dependency_walk.source_ref AND relation_edge.relation_type = 'depends-on' AND dependency_walk.depth < ?
        AND instr(dependency_walk.visited_path, char(31) || relation_edge.target_ref || char(31)) = 0
    ), dependency_rows AS (
      SELECT dependency_walk.seed_order, dependency_walk.depth, dependency_walk.visited_path, task_relation.relation_id, task_relation.source_ref, task_relation.target_ref, task_relation.relation_type, task_relation.direction, task_relation.strength, task_relation.origin, task_relation.state, task_relation.rationale, task_relation.owner_ref, task_relation.source_path, task_relation.record_index
      FROM dependency_walk CROSS JOIN task_relation INDEXED BY task_relation_source
      WHERE task_relation.source_ref = dependency_walk.source_ref AND task_relation.relation_type = 'depends-on' AND NOT EXISTS (SELECT 1 FROM relation_edge WHERE relation_edge.relation_id = task_relation.relation_id)
      UNION ALL
      SELECT dependency_walk.seed_order, dependency_walk.depth, dependency_walk.visited_path, relation_edge.relation_id, relation_edge.source_ref, relation_edge.target_ref, relation_edge.relation_type, json_extract(relation_edge.row_json, '$.direction'), json_extract(relation_edge.row_json, '$.strength'), json_extract(relation_edge.row_json, '$.origin'), relation_edge.state, json_extract(relation_edge.row_json, '$.rationale'), relation_edge.owner_ref, json_extract(relation_edge.row_json, '$.sourcePath'), json_extract(relation_edge.row_json, '$.recordIndex')
      FROM dependency_walk CROSS JOIN relation_edge INDEXED BY relation_edge_source
      WHERE relation_edge.source_ref = dependency_walk.source_ref AND relation_edge.relation_type = 'depends-on'
    ), dependency_overflow AS (
      SELECT 1 AS present FROM dependency_walk CROSS JOIN task_relation INDEXED BY task_relation_source
      WHERE task_relation.source_ref = dependency_walk.source_ref AND dependency_walk.depth = ? AND task_relation.relation_type = 'depends-on'
        AND NOT EXISTS (SELECT 1 FROM relation_edge WHERE relation_edge.relation_id = task_relation.relation_id)
        AND instr(dependency_walk.visited_path, char(31) || task_relation.target_ref || char(31)) = 0
      UNION ALL
      SELECT 1 FROM dependency_walk CROSS JOIN relation_edge INDEXED BY relation_edge_source
      WHERE relation_edge.source_ref = dependency_walk.source_ref AND dependency_walk.depth = ? AND relation_edge.relation_type = 'depends-on'
        AND instr(dependency_walk.visited_path, char(31) || relation_edge.target_ref || char(31)) = 0
      LIMIT 1
    )
    SELECT 0 AS overflow, seed_order, depth, visited_path, relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index FROM dependency_rows
    UNION ALL SELECT 1, -1, -1, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM dependency_overflow
    ORDER BY overflow DESC, depth, seed_order, visited_path, relation_id`;
  const records = db
    .prepare(sql)
    .all(JSON.stringify(sourceRefs), maxDepth, maxDepth, maxDepth, maxDepth) as unknown as readonly (Record<
    string,
    unknown
  > & { readonly overflow: number })[];
  if (records[0]?.overflow === 1) throw new Error(`dependency closure depth limit ${maxDepth} exceeded`);
  const rows = new Map<string, TaskRelationProjectionRow>();
  for (const record of records)
    if (record.relation_id !== null) {
      const row = taskRelationRow(record);
      if (!rows.has(row.relationId)) rows.set(row.relationId, row);
    }
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
  return (
    db.prepare(sql).all(...(scoped ? [JSON.stringify(taskIds)] : [])) as unknown as readonly {
      readonly task_id: string;
      readonly status: string | null;
    }[]
  ).map((row) => ({ taskId: row.task_id, status: row.status }));
}

/** Indexed narrow page over the task snapshot table; order matches the unparameterized list (task id asc). */
export function listTaskRowsNarrow(
  db: DatabaseSync,
  query: TaskProjectionListQuery,
): { readonly rows: readonly NarrowTaskRow[]; readonly page: ProjectionPage | null } {
  const values: (string | number)[] = [],
    where: string[] = [];
  if (query.status !== undefined) {
    where.push("task_snapshot.status = ?");
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
  const paged = query.limit !== undefined || query.cursor !== undefined,
    pageLimit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  const sql = `SELECT task_snapshot.task_id AS task_id, task_package.package_path AS package_path, COALESCE(task_generation.generation, 'v1') AS generation, task_snapshot.workspace_revision AS workspace_revision, ${taskCreatedAtSql("task_snapshot.task_id")} AS created_at, task_snapshot.updated_at AS updated_at, task_snapshot.pinned AS pinned FROM task_snapshot LEFT JOIN task_package USING(task_id) LEFT JOIN task_generation USING(task_id)${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${query.pinnedFirst ? "task_snapshot.pinned DESC, " : ""}task_snapshot.task_id${pageLimit === null ? "" : " LIMIT ?"}`;
  if (pageLimit !== null) values.push(pageLimit + 1);
  const raw = db.prepare(sql).all(...values) as unknown as readonly NarrowTaskRow[],
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
 * Narrow page over the event-backed relation edges: task-owned rows plus the
 * decision/fact-owned `relation_edge` rows, converged by relation id with the
 * event side winning (the same precedence the wide read's merge applies).
 */
export function readTaskRelationPage(
  db: DatabaseSync,
  query: TaskRelationQuery,
): { readonly rows: readonly TaskRelationProjectionRow[]; readonly page: ProjectionPage | null } {
  // Task-owned rows carry their snapshot-write timestamp directly; decision/fact-owned
  // edges join the event that wrote them for the same "updated" semantics.
  const taskRows =
    "SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index, workspace_revision, updated_at FROM task_relation WHERE NOT EXISTS (SELECT 1 FROM relation_edge WHERE relation_edge.relation_id = task_relation.relation_id)";
  const eventRows =
    "SELECT relation_id, source_ref, target_ref, relation_type, json_extract(row_json, '$.direction') AS direction, json_extract(row_json, '$.strength') AS strength, json_extract(row_json, '$.origin') AS origin, state, json_extract(row_json, '$.rationale') AS rationale, owner_ref, json_extract(row_json, '$.sourcePath') AS source_path, json_extract(row_json, '$.recordIndex') AS record_index, workspace_revision, (SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE event_index.workspace_revision = relation_edge.workspace_revision) AS updated_at FROM relation_edge";
  const where: string[] = [],
    values: (string | number)[] = [];
  if (query.entity !== undefined) {
    where.push("(source_ref = ? OR target_ref = ?)");
    values.push(query.entity, query.entity);
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
    where.push("relation_type = ?");
    values.push(query.relationType);
  }
  if (query.state !== undefined) {
    where.push("state = ?");
    values.push(query.state);
  }
  if (query.updatedAfter !== undefined) {
    where.push("updated_at >= ?");
    values.push(query.updatedAfter);
  }
  if (query.updatedBefore !== undefined) {
    where.push("updated_at <= ?");
    values.push(query.updatedBefore);
  }
  if (query.cursor !== undefined) {
    const [relationId] = decodePageCursor(query.cursor, 1);
    where.push("relation_id > ?");
    values.push(relationId!);
  }
  const paged = query.limit !== undefined || query.cursor !== undefined,
    pageLimit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  const sql = `SELECT * FROM (${taskRows} UNION ALL ${eventRows})${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY relation_id${pageLimit === null ? "" : " LIMIT ?"}`;
  if (pageLimit !== null) values.push(pageLimit + 1);
  const raw = db.prepare(sql).all(...values) as unknown as readonly Record<string, unknown>[],
    visible = pageLimit === null ? raw : raw.slice(0, pageLimit),
    rows = visible.map(taskRelationRow);
  if (pageLimit === null) return { rows, page: null };
  const last = rows.at(-1);
  return {
    rows,
    page: {
      limit: pageLimit,
      cursor: query.cursor ?? null,
      nextCursor: raw.length > pageLimit && last ? encodePageCursor([last.relationId]) : null,
    },
  };
}

function taskRelationRow(row: Record<string, unknown>): TaskRelationProjectionRow {
  return {
    relationId: String(row.relation_id),
    sourceRef: String(row.source_ref),
    targetRef: String(row.target_ref),
    relationType: String(row.relation_type) as TaskRelationProjectionRow["relationType"],
    direction: String(row.direction) as TaskRelationProjectionRow["direction"],
    strength: String(row.strength) as TaskRelationProjectionRow["strength"],
    origin: String(row.origin) as TaskRelationProjectionRow["origin"],
    state: String(row.state) as TaskRelationProjectionRow["state"],
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
