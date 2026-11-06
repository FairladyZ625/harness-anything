// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createProjectionTables } from "../../src/projection/projection-tables.ts";

test("an existing lease_interval learns task_active before its index is created", () => {
  const db = new DatabaseSync(":memory:");
  // Schema 38 table, before the visibility flag existed.
  db.exec(`CREATE TABLE lease_interval (
    task_id TEXT NOT NULL, execution_id TEXT NOT NULL, acquired_revision INTEGER NOT NULL,
    released_revision INTEGER, holder_json TEXT NOT NULL, previous_holder_json TEXT,
    lease_expires_at TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY(task_id, execution_id, acquired_revision))`);
  db.exec(`INSERT INTO lease_interval VALUES ('task_old', 'execution_old', 1, NULL, '{}', NULL,
    '2000-01-01T00:00:00.000Z', 'test')`);
  createProjectionTables(db);
  const columns = db.prepare("PRAGMA table_info(lease_interval)").all() as { name: string }[];
  assert.ok(columns.some(({ name }) => name === "task_active"));
  // The migration marks the historical row inactive because its task is not active.
  db.prepare(
    "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, 1, ?, 'done', '2026-11-05T00:00:00.000Z')",
  ).run("task_old", JSON.stringify({ task: { title: "done", pinned: false } }));
  createProjectionTables(db);
  assert.equal(
    (
      db.prepare("SELECT task_active AS active FROM lease_interval WHERE task_id='task_old'").get() as {
        active: number;
      }
    ).active,
    0,
  );
  db.close();
});
