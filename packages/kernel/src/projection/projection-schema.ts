import { DatabaseSync } from "node:sqlite";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";

// Version 11 adds the rebuildable squad-run projection. A version mismatch takes
// the existing discard-and-replay path in rebuildable-task-projection.ts. The
// canonical ledger is replayed first; squad-coordinator then sees its durable
// ready marker cleared and replays the dispatch streams into the local-only table.
export const taskProjectionSchemaVersion = 11;

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
