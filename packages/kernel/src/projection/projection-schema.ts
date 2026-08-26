import { DatabaseSync } from "node:sqlite";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";

// Version 12 combines the rebuildable squad-run projection added in version 11
// with UTC ISO-8601 Z materialized timestamps. Immutable event bytes retain their
// historical offset spelling. A version mismatch takes the discard-and-replay
// path in rebuildable-task-projection.ts; squad-coordinator then sees its durable
// ready marker cleared and replays dispatch streams into the local-only table.
export const taskProjectionSchemaVersion = 12;

export function readTaskProjectionSchemaVersion(projectionPath: string): number | null {
  if (!localRuntimeStateFileSystem.exists(projectionPath)) return null;
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_meta'").all();
    if (tables.length === 0) return null;
    const columns = db.prepare("PRAGMA table_info(projection_meta)").all() as readonly { readonly name?: unknown }[];
    if (!columns.some(({ name }) => name === "schema_version")) return 0;
    const row = db.prepare("SELECT schema_version FROM projection_meta WHERE singleton=1").get() as
      | { readonly schema_version?: unknown }
      | undefined;
    return row?.schema_version === undefined ? 0 : Number(row.schema_version);
  } finally {
    db.close();
  }
}
