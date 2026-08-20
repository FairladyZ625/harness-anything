// No @write-boundary-exemption marker is needed here: this module never opens a
// database itself — it receives the already-open rebuildable projection handle
// from rebuildable-task-projection.ts, which owns the governed writable open.
import type { DatabaseSync } from "node:sqlite";
import type { EntityRelationRecord } from "../domain/entity-relation.ts";
import type { ReplayTaskStatus, TaskV1 } from "../domain/task.ts";

/**
 * Narrow-query companions for the rebuildable task projection. Everything here
 * reads or maintains disposable derived tables inside task.sqlite; the
 * authoritative source stays the canonical event stream, and every write flows
 * through the projection's own transaction (apply/rebuild/cold catch-up).
 */
export interface ProjectionPage { readonly limit: number; readonly cursor: string | null; readonly nextCursor: string | null }
export interface TaskProjectionListQuery { readonly status?: ReplayTaskStatus; readonly updatedAfter?: string; readonly updatedBefore?: string; readonly limit?: number; readonly cursor?: string }
export interface TaskRelationQuery { readonly entity?: string; readonly source?: string; readonly target?: string; readonly relationType?: string; readonly state?: string; readonly updatedAfter?: string; readonly updatedBefore?: string; readonly limit?: number; readonly cursor?: string }
export interface TaskRelationProjectionRow { readonly relationId: string; readonly sourceRef: string; readonly targetRef: string; readonly relationType: EntityRelationRecord["type"]; readonly direction: EntityRelationRecord["direction"]; readonly strength: EntityRelationRecord["strength"]; readonly origin: EntityRelationRecord["origin"]; readonly state: EntityRelationRecord["state"]; readonly rationale: string; readonly ownerRef: string; readonly sourcePath: string; readonly recordIndex: number }
export interface NarrowTaskRow { readonly task_id: string; readonly package_path: string | null; readonly generation: "v0" | "v1"; readonly workspace_revision: number; readonly updated_at: string }

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
export function refreshTaskRelationProjection(db: DatabaseSync, taskId: string, task: TaskV1 | null, revision: number, updatedAt: string, packagePath?: string | null): void {
  db.prepare("DELETE FROM task_relation WHERE task_id = ?").run(taskId);
  if (!task?.relations?.length) return;
  const resolvedPackagePath = packagePath ?? (db.prepare("SELECT package_path FROM task_package WHERE task_id = ?").get(taskId) as { readonly package_path: string } | undefined)?.package_path ?? `harness/tasks/${taskId}`;
  const ownerRef = `task/${taskId}`, sourcePath = `${resolvedPackagePath}/INDEX.md`;
  const insert = db.prepare("INSERT OR REPLACE INTO task_relation(relation_id, task_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index, workspace_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [recordIndex, relation] of task.relations.entries()) insert.run(relation.relation_id, taskId, relation.source, relation.target, relation.type, relation.direction, relation.strength, relation.origin, relation.state, relation.rationale, ownerRef, sourcePath, recordIndex, revision, updatedAt);
}

/** Every task-owned edge, ordered by relation id — the event-side task rows of the converged relation graph. */
export function readTaskRelationRows(db: DatabaseSync): readonly TaskRelationProjectionRow[] {
  return (db.prepare("SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index FROM task_relation ORDER BY relation_id").all() as unknown as readonly Record<string, unknown>[]).map(taskRelationRow);
}

/** Cheap id+status pairs from the maintained columns — the blocking judgment's task input
 * without materializing any snapshot JSON. */
export function readTaskStatusRows(db: DatabaseSync, taskIds?: readonly string[]): readonly { readonly taskId: string; readonly status: string | null }[] {
  if (taskIds?.length === 0) return [];
  // An id list above SQLite's parameter budget reads every row and filters in memory instead.
  const scoped = taskIds !== undefined && taskIds.length <= 900;
  const memoryIds = taskIds !== undefined && !scoped ? new Set(taskIds) : null;
  const sql = scoped ? `SELECT task_id, status FROM task_snapshot WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY task_id` : "SELECT task_id, status FROM task_snapshot ORDER BY task_id";
  const rows = (db.prepare(sql).all(...(scoped ? taskIds : [])) as unknown as readonly { readonly task_id: string; readonly status: string | null }[]).map((row) => ({ taskId: row.task_id, status: row.status }));
  return memoryIds === null ? rows : rows.filter((row) => memoryIds.has(row.taskId));
}

/** Indexed narrow page over the task snapshot table; order matches the unparameterized list (task id asc). */
export function listTaskRowsNarrow(db: DatabaseSync, query: TaskProjectionListQuery): { readonly rows: readonly NarrowTaskRow[]; readonly page: ProjectionPage | null } {
  const values: (string | number)[] = [], where: string[] = [];
  if (query.status !== undefined) { where.push("task_snapshot.status = ?"); values.push(query.status); }
  if (query.updatedAfter !== undefined) { where.push("task_snapshot.updated_at >= ?"); values.push(query.updatedAfter); }
  if (query.updatedBefore !== undefined) { where.push("task_snapshot.updated_at <= ?"); values.push(query.updatedBefore); }
  if (query.cursor !== undefined) { const [taskId] = decodePageCursor(query.cursor, 1); where.push("task_snapshot.task_id > ?"); values.push(taskId!); }
  const paged = query.limit !== undefined || query.cursor !== undefined, pageLimit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  const sql = `SELECT task_snapshot.task_id AS task_id, task_package.package_path AS package_path, COALESCE(task_generation.generation, 'v1') AS generation, task_snapshot.workspace_revision AS workspace_revision, task_snapshot.updated_at AS updated_at FROM task_snapshot LEFT JOIN task_package USING(task_id) LEFT JOIN task_generation USING(task_id)${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY task_snapshot.task_id${pageLimit === null ? "" : " LIMIT ?"}`;
  if (pageLimit !== null) values.push(pageLimit + 1);
  const raw = db.prepare(sql).all(...values) as unknown as readonly NarrowTaskRow[], visible = pageLimit === null ? raw : raw.slice(0, pageLimit);
  if (pageLimit === null) return { rows: visible, page: null };
  const last = visible.at(-1);
  return { rows: visible, page: { limit: pageLimit, cursor: query.cursor ?? null, nextCursor: raw.length > pageLimit && last ? encodePageCursor([last.task_id]) : null } };
}

/**
 * Narrow page over the event-backed relation edges: task-owned rows plus the
 * decision/fact-owned `relation_edge` rows, converged by relation id with the
 * event side winning (the same precedence the wide read's merge applies).
 */
export function readTaskRelationPage(db: DatabaseSync, query: TaskRelationQuery): { readonly rows: readonly TaskRelationProjectionRow[]; readonly page: ProjectionPage | null } {
  // Task-owned rows carry their snapshot-write timestamp directly; decision/fact-owned
  // edges join the event that wrote them for the same "updated" semantics.
  const taskRows = "SELECT relation_id, source_ref, target_ref, relation_type, direction, strength, origin, state, rationale, owner_ref, source_path, record_index, workspace_revision, updated_at FROM task_relation WHERE NOT EXISTS (SELECT 1 FROM relation_edge WHERE relation_edge.relation_id = task_relation.relation_id)";
  const eventRows = "SELECT relation_id, source_ref, target_ref, relation_type, json_extract(row_json, '$.direction') AS direction, json_extract(row_json, '$.strength') AS strength, json_extract(row_json, '$.origin') AS origin, state, json_extract(row_json, '$.rationale') AS rationale, owner_ref, json_extract(row_json, '$.sourcePath') AS source_path, json_extract(row_json, '$.recordIndex') AS record_index, workspace_revision, (SELECT json_extract(event_json, '$.occurredAt') FROM event_index WHERE event_index.workspace_revision = relation_edge.workspace_revision) AS updated_at FROM relation_edge";
  const where: string[] = [], values: (string | number)[] = [];
  if (query.entity !== undefined) { where.push("(source_ref = ? OR target_ref = ?)"); values.push(query.entity, query.entity); }
  if (query.source !== undefined) { where.push("source_ref = ?"); values.push(query.source); }
  if (query.target !== undefined) { where.push("target_ref = ?"); values.push(query.target); }
  if (query.relationType !== undefined) { where.push("relation_type = ?"); values.push(query.relationType); }
  if (query.state !== undefined) { where.push("state = ?"); values.push(query.state); }
  if (query.updatedAfter !== undefined) { where.push("updated_at >= ?"); values.push(query.updatedAfter); }
  if (query.updatedBefore !== undefined) { where.push("updated_at <= ?"); values.push(query.updatedBefore); }
  if (query.cursor !== undefined) { const [relationId] = decodePageCursor(query.cursor, 1); where.push("relation_id > ?"); values.push(relationId!); }
  const paged = query.limit !== undefined || query.cursor !== undefined, pageLimit = query.limit === undefined ? (paged ? 100 : null) : checkedPageLimit(query.limit);
  const sql = `SELECT * FROM (${taskRows} UNION ALL ${eventRows})${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY relation_id${pageLimit === null ? "" : " LIMIT ?"}`;
  if (pageLimit !== null) values.push(pageLimit + 1);
  const raw = db.prepare(sql).all(...values) as unknown as readonly Record<string, unknown>[], visible = pageLimit === null ? raw : raw.slice(0, pageLimit), rows = visible.map(taskRelationRow);
  if (pageLimit === null) return { rows, page: null };
  const last = rows.at(-1);
  return { rows, page: { limit: pageLimit, cursor: query.cursor ?? null, nextCursor: raw.length > pageLimit && last ? encodePageCursor([last.relationId]) : null } };
}

function taskRelationRow(row: Record<string, unknown>): TaskRelationProjectionRow {
  return { relationId: String(row.relation_id), sourceRef: String(row.source_ref), targetRef: String(row.target_ref), relationType: String(row.relation_type) as TaskRelationProjectionRow["relationType"], direction: String(row.direction) as TaskRelationProjectionRow["direction"], strength: String(row.strength) as TaskRelationProjectionRow["strength"], origin: String(row.origin) as TaskRelationProjectionRow["origin"], state: String(row.state) as TaskRelationProjectionRow["state"], rationale: String(row.rationale ?? ""), ownerRef: String(row.owner_ref), sourcePath: String(row.source_path), recordIndex: Number(row.record_index) };
}

export function checkedPageLimit(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error("query page limit must be an integer between 1 and 500"); return value; }
export function encodePageCursor(parts: readonly string[]): string { return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url"); }
export function decodePageCursor(value: string, expected: number): readonly string[] { let parsed: unknown; try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("query cursor is invalid"); } if (!Array.isArray(parsed) || parsed.length !== expected || parsed.some((part) => typeof part !== "string" || part.length === 0)) throw new Error("query cursor is invalid"); return parsed; }
