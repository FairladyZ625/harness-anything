import type { DatabaseSync } from "node:sqlite";

/**
 * The edge task read model (dec_0C26B97C5B6CEA37101FC0A84D): the center publishes its own
 * task_snapshot/task_package rows into each replica cut, one file per task, and an edge loads them
 * into tables built from the same DDL so the center's task-index queries run unchanged on the edge.
 */
export const READ_MODEL_SCHEMA_GENERATION = 1 as const;
export const TASK_READ_MODEL_PREFIX = ".read-model/tasks/";
export const TASK_READ_MODEL_META_PATH = ".read-model/tasks.meta.json";

/** The task index tables shared by the center projection and the edge read model. */
export const TASK_INDEX_TABLES_SQL = `
    CREATE TABLE IF NOT EXISTS task_snapshot (
      task_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT,
      pinned INTEGER NOT NULL GENERATED ALWAYS AS (
        json_extract(snapshot_json, '$.task.pinned')
      ) STORED,
      package_disposition TEXT NOT NULL GENERATED ALWAYS AS (
        COALESCE(json_extract(snapshot_json, '$.task.packageDisposition'), 'active')
      ) STORED,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS task_snapshot_status_updated ON task_snapshot(status, updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_updated_task ON task_snapshot(updated_at DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_revision_task ON task_snapshot(workspace_revision, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_agenda_status_pin ON task_snapshot(status, pinned DESC, task_id ASC);
    CREATE INDEX IF NOT EXISTS task_snapshot_parent
      ON task_snapshot(json_extract(snapshot_json, '$.task.metadata.parentTaskId'));
    CREATE TABLE IF NOT EXISTS task_package (task_id TEXT PRIMARY KEY, package_path TEXT NOT NULL UNIQUE);`;

export interface TaskReadModelRow {
  readonly taskId: string;
  readonly workspaceRevision: number;
  readonly snapshotJson: string;
  readonly status: string | null;
  readonly updatedAt: string;
  readonly packagePath: string | null;
}

export interface TaskReadModelMeta {
  readonly schemaGeneration: typeof READ_MODEL_SCHEMA_GENERATION;
  readonly sourceRevision: number;
  readonly rootThreshold: number;
}

export function taskReadModelPath(taskId: string): string {
  return `${TASK_READ_MODEL_PREFIX}${taskId}.json`;
}

export function readTaskReadModelRows(db: DatabaseSync): readonly TaskReadModelRow[] {
  return (
    db
      .prepare(
        "SELECT task_snapshot.task_id, workspace_revision, snapshot_json, status, updated_at, package_path FROM task_snapshot LEFT JOIN task_package USING(task_id) ORDER BY task_snapshot.task_id",
      )
      .all() as readonly Record<string, unknown>[]
  ).map((row) => ({
    taskId: String(row.task_id),
    workspaceRevision: Number(row.workspace_revision),
    snapshotJson: String(row.snapshot_json),
    status: row.status === null ? null : String(row.status),
    updatedAt: String(row.updated_at),
    packagePath: row.package_path === null ? null : String(row.package_path),
  }));
}

export function serializeTaskReadModelRow(row: TaskReadModelRow): string {
  return JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, ...row });
}

export function serializeTaskReadModelMeta(meta: Omit<TaskReadModelMeta, "schemaGeneration">): string {
  return JSON.stringify({ schemaGeneration: READ_MODEL_SCHEMA_GENERATION, ...meta });
}

export function parseTaskReadModelMeta(text: string): TaskReadModelMeta {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (
    value.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION ||
    !Number.isSafeInteger(value.sourceRevision) ||
    !Number.isSafeInteger(value.rootThreshold)
  )
    throw new Error("task read model meta is incompatible");
  return value as unknown as TaskReadModelMeta;
}

/** Loads one published row; a row from another schema generation is rejected, never coerced. */
export function upsertTaskReadModelRow(db: DatabaseSync, text: string): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.schemaGeneration !== READ_MODEL_SCHEMA_GENERATION || typeof value.taskId !== "string")
    throw new Error("task read model row is incompatible");
  const row = value as unknown as TaskReadModelRow & { readonly schemaGeneration: number };
  db.prepare(
    "INSERT OR REPLACE INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(row.taskId, row.workspaceRevision, row.snapshotJson, row.status, row.updatedAt);
  db.prepare("DELETE FROM task_package WHERE task_id = ?").run(row.taskId);
  if (row.packagePath !== null)
    db.prepare("INSERT INTO task_package(task_id, package_path) VALUES (?, ?)").run(row.taskId, row.packagePath);
  return row.taskId;
}

export function deleteTaskReadModelRow(db: DatabaseSync, taskId: string): void {
  db.prepare("DELETE FROM task_snapshot WHERE task_id = ?").run(taskId);
  db.prepare("DELETE FROM task_package WHERE task_id = ?").run(taskId);
}
