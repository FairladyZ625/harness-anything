import type { DatabaseSync } from "node:sqlite";
import { TaskEventStoreError } from "@harness-anything/kernel";
import { migrationWritable, type StorageMigrationRecord } from "./types.ts";

export function ensureSqliteMigrationControl(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS storage_migration_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1), record_json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS storage_migration_scope(singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope_json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS storage_activation_markers(run_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;`);
}
export function readSqliteMigrationControl(db: DatabaseSync): StorageMigrationRecord | null {
  // Old read-only ledgers predate this table; mutable open installs it before accepting writes.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_migration_control'").get()) return null;
  const row = db.prepare("SELECT record_json FROM storage_migration_control WHERE singleton=1").get();
  return row ? (JSON.parse(String(row.record_json)) as StorageMigrationRecord) : null;
}
export function assertSqliteMigrationWritable(db: DatabaseSync): void {
  if (!migrationWritable(readSqliteMigrationControl(db)))
    throw new TaskEventStoreError(
      "revision_conflict",
      "storage_migration_read_only: recover the persisted migration before writing",
    );
}
