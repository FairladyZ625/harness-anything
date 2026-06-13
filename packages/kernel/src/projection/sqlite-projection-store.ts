import { mkdirSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { ProjectionMeta, TaskProjectionRow } from "./types.ts";

const projectionVersion = "task-projection/v1";

export function writeProjectionDatabase(projectionPath: string, rows: ReadonlyArray<TaskProjectionRow>, meta: ProjectionMeta): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const tempPath = `${projectionPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempPath, { force: true });
  const db = new DatabaseSync(tempPath);
  try {
    db.exec([
      "PRAGMA journal_mode = DELETE",
      "CREATE TABLE projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      [
        "CREATE TABLE task_projection (",
        "  task_id TEXT PRIMARY KEY,",
        "  row_json TEXT NOT NULL",
        ")"
      ].join("\n")
    ].join(";\n"));
    const insertMeta = db.prepare("INSERT INTO projection_meta (key, value) VALUES (?, ?)");
    insertMeta.run("version", projectionVersion);
    insertMeta.run("sourceHash", meta.sourceHash);
    insertMeta.run("rowsHash", meta.rowsHash);
    const insertRow = db.prepare("INSERT OR REPLACE INTO task_projection (task_id, row_json) VALUES (?, ?)");
    for (const row of rows) {
      insertRow.run(row.taskId, JSON.stringify(row));
    }
  } finally {
    db.close();
  }
  renameSync(tempPath, projectionPath);
}

function readProjectionDatabase(projectionPath: string): { readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const metaRows = db.prepare("SELECT key, value FROM projection_meta").all() as unknown as ReadonlyArray<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const rowRecords = db.prepare("SELECT row_json FROM task_projection ORDER BY task_id").all() as unknown as ReadonlyArray<{ row_json: string }>;
    return {
      meta: {
        sourceHash: meta.get("sourceHash") ?? "",
        rowsHash: meta.get("rowsHash") ?? ""
      },
      rows: rowRecords.map((record) => JSON.parse(record.row_json) as TaskProjectionRow)
    };
  } finally {
    db.close();
  }
}

export function tryReadProjectionDatabase(
  projectionPath: string
): { readonly ok: true; readonly rows: ReadonlyArray<TaskProjectionRow>; readonly meta: ProjectionMeta } | { readonly ok: false } {
  try {
    return {
      ok: true,
      ...readProjectionDatabase(projectionPath)
    };
  } catch {
    return { ok: false };
  }
}
