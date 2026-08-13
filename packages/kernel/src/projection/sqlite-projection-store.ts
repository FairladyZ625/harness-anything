// @write-boundary-exemption rebuildable-projection
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import type {
  ProjectionMeta,
  TaskFieldExtensionProjection,
  TaskProjectionRow
} from "./types.ts";

export const projectionVersion = "entity-projection/d4-v3";
const baseTaskProjectionColumns = [
  "task_id",
  "title",
  "parent_task_id",
  "work_kind",
  "risk_tier",
  "urgency",
  "canonical_status",
  "coordination_status",
  "raw_status",
  "package_disposition",
  "closeout_readiness",
  "lifecycle_engine",
  "freshness",
  "updated_at",
  "source",
  "source_path",
  "vertical",
  "preset",
  "profile",
  "module_key",
  "module_title",
  "has_lesson_candidates",
  "created_by_json"
] as const;

export function writeProjectionDatabase(
  projectionPath: string,
  rows: ReadonlyArray<TaskProjectionRow>,
  meta: ProjectionMeta,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const tempPath = `${projectionPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  runSqlite(tempPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = DELETE`;
    yield* sql`CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    yield* sql`
      CREATE TABLE task_projection (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        parent_task_id TEXT,
        canonical_status TEXT NOT NULL,
        coordination_status TEXT NOT NULL,
        raw_status TEXT NOT NULL,
        package_disposition TEXT NOT NULL,
        closeout_readiness TEXT NOT NULL,
        lifecycle_engine TEXT NOT NULL,
        freshness TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL,
        source_path TEXT NOT NULL,
        work_kind TEXT,
        risk_tier TEXT,
        urgency TEXT,
        vertical TEXT,
        preset TEXT,
        profile TEXT,
        module_key TEXT,
        module_title TEXT,
        has_lesson_candidates INTEGER NOT NULL,
        created_by_json TEXT
      )
    `;
    const projectedTaskFieldExtensions = queryableTaskFieldExtensions(taskFieldExtensions);
    for (const extension of projectedTaskFieldExtensions) {
      yield* addTaskProjectionColumn(sql, extension.projection.column);
    }
    yield* insertMeta(sql, "version", projectionVersion);
    yield* insertMeta(sql, "sourceHash", meta.sourceHash);
    yield* insertMeta(sql, "rowsHash", meta.rowsHash);
    for (const row of rows) yield* insertTaskRow(sql, row, projectedTaskFieldExtensions);
    yield* sql`CREATE INDEX task_projection_status ON task_projection (canonical_status, coordination_status)`;
    yield* sql`CREATE INDEX task_projection_parent_task_id ON task_projection (parent_task_id)`;
    yield* sql`CREATE INDEX task_projection_module_key ON task_projection (module_key)`;
  }));
  renameSync(tempPath, projectionPath);
}

export function tryReadProjectionDatabase(
  projectionPath: string,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): { readonly ok: true; readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } | { readonly ok: false } {
  try {
    return {
      ok: true,
      ...readProjectionDatabase(projectionPath, taskFieldExtensions)
    };
  } catch {
    return { ok: false };
  }
}

export function queryTaskChildrenRows(projectionPath: string, parentTaskId: string): ReadonlyArray<TaskProjectionRow> {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql.unsafe<TaskRecord>("SELECT * FROM task_projection WHERE parent_task_id = ? ORDER BY task_id", [parentTaskId]);
    return records.map((record) => recordToTaskRow(record));
  }));
}

function readProjectionDatabase(
  projectionPath: string,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly meta: ProjectionMeta;
} {
  return runSqlite(projectionPath, Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const metaRows = yield* sql`SELECT key, value FROM projection_meta`;
    const meta = new Map(metaRows.map((row) => [String(row.key), String(row.value)]));
    const taskRecords = yield* sql.unsafe<TaskRecord>("SELECT * FROM task_projection ORDER BY task_id");
    return {
      meta: {
        version: meta.get("version"),
        sourceHash: meta.get("sourceHash") ?? "",
        rowsHash: meta.get("rowsHash") ?? ""
      },
      rows: taskRecords.map((record) => recordToTaskRow(record, taskFieldExtensions))
    };
  }));
}

export function runSqlite<A>(filename: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): A {
  return Effect.runSync(Effect.provide(effect, SqliteClient.layer({ filename })));
}

function insertMeta(sql: SqlClient.SqlClient, key: string, value: string): Effect.Effect<unknown, unknown> {
  return sql`INSERT INTO projection_meta (key, value) VALUES (${key}, ${value})`;
}

function addTaskProjectionColumn(sql: SqlClient.SqlClient, column: string): Effect.Effect<unknown, unknown> {
  return sql.unsafe(`ALTER TABLE task_projection ADD COLUMN ${quoteIdentifier(column)} TEXT`);
}

export function insertTaskRow(
  sql: SqlClient.SqlClient,
  row: TaskProjectionRow,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection>
): Effect.Effect<unknown, unknown> {
  const extensionColumns = taskFieldExtensions.map((extension) => extension.projection.column);
  const columns = [...baseTaskProjectionColumns, ...extensionColumns].map(quoteIdentifier);
  const values = [
    row.taskId,
    row.title,
    row.parentTaskId ?? null,
    row.workKind ?? null,
    row.riskTier ?? null,
    row.urgency ?? null,
    row.canonicalStatus,
    row.coordinationStatus,
    row.rawStatus,
    row.packageDisposition,
    row.closeoutReadiness,
    row.lifecycleEngine,
    row.freshness,
    row.updatedAt,
    row.source,
    row.sourcePath,
    row.vertical ?? null,
    row.preset ?? null,
    row.profile ?? null,
    row.moduleKey ?? null,
    row.moduleTitle ?? null,
    row.hasLessonCandidates === true ? 1 : 0,
    row.createdBy ? JSON.stringify(row.createdBy) : null,
    ...taskFieldExtensions.map((extension) => row.fieldExtensions?.[extension.field] ?? extension.default)
  ];
  return sql.unsafe(
    `INSERT OR REPLACE INTO task_projection (${columns.join(", ")}) VALUES (${values.map(() => "?").join(", ")})`,
    values
  );
}

interface TaskRecord {
  readonly [column: string]: unknown;
  readonly task_id: string;
  readonly title: string;
  readonly parent_task_id: string | null;
  readonly work_kind: string | null;
  readonly risk_tier: string | null;
  readonly urgency: string | null;
  readonly canonical_status: string;
  readonly coordination_status: string;
  readonly raw_status: string;
  readonly package_disposition: string;
  readonly closeout_readiness: string;
  readonly lifecycle_engine: string;
  readonly freshness: string;
  readonly updated_at: string;
  readonly source: string;
  readonly source_path: string;
  readonly vertical: string | null;
  readonly preset: string | null;
  readonly profile: string | null;
  readonly module_key: string | null;
  readonly module_title: string | null;
  readonly has_lesson_candidates: number;
  readonly created_by_json: string | null;
}

function recordToTaskRow(
  record: TaskRecord,
  taskFieldExtensions: ReadonlyArray<TaskFieldExtensionProjection> = []
): TaskProjectionRow {
  const createdBy = record.created_by_json ? JSON.parse(record.created_by_json) as TaskProjectionRow["createdBy"] : undefined;
  const fieldExtensions = readTaskFieldExtensionRecord(record, taskFieldExtensions);
  return {
    schema: "sqlite-task-row/v1",
    taskId: record.task_id,
    title: record.title,
    ...(record.parent_task_id ? { parentTaskId: record.parent_task_id } : {}),
    ...(record.work_kind ? { workKind: record.work_kind as TaskProjectionRow["workKind"] } : {}),
    ...(record.risk_tier ? { riskTier: record.risk_tier as TaskProjectionRow["riskTier"] } : {}),
    ...(record.urgency ? { urgency: record.urgency as TaskProjectionRow["urgency"] } : {}),
    canonicalStatus: record.canonical_status as TaskProjectionRow["canonicalStatus"],
    coordinationStatus: record.coordination_status as TaskProjectionRow["coordinationStatus"],
    rawStatus: record.raw_status,
    packageDisposition: record.package_disposition as TaskProjectionRow["packageDisposition"],
    closeoutReadiness: record.closeout_readiness as TaskProjectionRow["closeoutReadiness"],
    lifecycleEngine: record.lifecycle_engine,
    freshness: record.freshness as TaskProjectionRow["freshness"],
    updatedAt: record.updated_at,
    source: record.source as TaskProjectionRow["source"],
    sourcePath: record.source_path,
    ...(record.vertical ? { vertical: record.vertical } : {}),
    ...(record.preset ? { preset: record.preset } : {}),
    ...(record.profile ? { profile: record.profile } : {}),
    ...(record.module_key ? { moduleKey: record.module_key } : {}),
    ...(record.module_title ? { moduleTitle: record.module_title } : {}),
    hasLessonCandidates: record.has_lesson_candidates === 1,
    ...(createdBy ? { createdBy } : {}),
    ...(fieldExtensions ? { fieldExtensions } : {})
  };
}

export function queryableTaskFieldExtensions(
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): ReadonlyArray<TaskFieldExtensionProjection> {
  const seen = new Set<string>(baseTaskProjectionColumns);
  const projected: TaskFieldExtensionProjection[] = [];
  for (const extension of extensions) {
    if (!extension.projection.queryable) continue;
    if (seen.has(extension.projection.column)) continue;
    seen.add(extension.projection.column);
    projected.push(extension);
  }
  return projected;
}

function readTaskFieldExtensionRecord(
  record: TaskRecord,
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): Readonly<Record<string, string | null>> | undefined {
  const projected = queryableTaskFieldExtensions(extensions);
  if (projected.length === 0) return undefined;
  const values = Object.fromEntries(projected.map((extension) => {
    const rawValue = record[extension.projection.column];
    return [extension.field, typeof rawValue === "string" ? rawValue : null];
  }));
  return Object.values(values).some((value) => value !== null) ? values : undefined;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
