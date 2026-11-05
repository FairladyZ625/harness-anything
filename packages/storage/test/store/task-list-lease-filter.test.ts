// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REPOSITORY_READ_TABLES_SQL, TASK_INDEX_TABLES_SQL } from "../../src/projection/projection-tables.ts";
import { listTaskRowsNarrow } from "../../src/projection/task-query-projection.ts";

/** Fleet starts from live lease rows. Expanding either lease-less actives or expired leases on
 * inactive tasks must not enlarge the scan: the SQLite read starts from the active-lease index. */
test("leaseOnly scans only active leases, keeping orphaned active leases and dropping expired inactive ones", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(TASK_INDEX_TABLES_SQL);
  db.exec(REPOSITORY_READ_TABLES_SQL);
  db.exec("CREATE TABLE task_generation (task_id TEXT PRIMARY KEY, generation TEXT NOT NULL)");
  const insert = db.prepare(
      "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, ?, '2026-11-05T00:00:00.000Z')",
    ),
    lease = db.prepare(
      "INSERT INTO lease_interval(task_id, execution_id, acquired_revision, released_revision, holder_json, previous_holder_json, lease_expires_at, reason, task_active) VALUES (?, ?, ?, NULL, '{}', NULL, ?, 'test', ?)",
    ),
    snapshot = JSON.stringify({ task: { title: "active", pinned: false } });
  for (let index = 0; index < 1_000; index += 1)
    insert.run(`task_${String(index).padStart(4, "0")}`, index + 1, snapshot, "active");
  // Expired-but-unreleased leases belong to inactive tasks: they are history, not fleet state.
  for (let index = 0; index < 1_000; index += 1)
    lease.run(
      `inactive_${String(index).padStart(4, "0")}`,
      `execution_i_${index}`,
      index + 1,
      "2000-01-01T00:00:00.000Z",
      0,
    );
  lease.run("task_0007", "execution_7", 1_001, "2999-01-01T00:00:00.000Z", 1);
  // A held lease past its expiry is orphaned: fleet must still show the disconnected task.
  lease.run("task_0008", "execution_8", 1_002, "2000-01-01T00:00:00.000Z", 1);

  const leased = listTaskRowsNarrow(db, { status: "active", leaseOnly: true, limit: 50 }),
    plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT DISTINCT task_id FROM lease_interval WHERE released_revision IS NULL AND task_active = 1",
      )
      .all()
      .map((row) => String((row as { detail: string }).detail))
      .join("\n");
  assert.deepEqual(
    leased.rows.map((row) => row.task_id),
    ["task_0007", "task_0008"],
  );
  assert.match(plan, /lease_interval_active/u);
  assert.doesNotMatch(plan, /SCAN lease_interval\b/u);
  db.close();
});
