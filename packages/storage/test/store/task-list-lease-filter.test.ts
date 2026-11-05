// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REPOSITORY_READ_TABLES_SQL, TASK_INDEX_TABLES_SQL } from "../../src/projection/projection-tables.ts";
import { listTaskRowsNarrow } from "../../src/projection/task-query-projection.ts";

/** Fleet starts from live leases. Expanding the lease-less active population must not enlarge
 * the page: the SQLite read joins the current-lease interval first instead of scanning actives. */
test("leaseOnly reaches only lease-bearing active tasks, independent of lease-less actives", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(TASK_INDEX_TABLES_SQL);
  db.exec(REPOSITORY_READ_TABLES_SQL);
  db.exec("CREATE TABLE task_generation (task_id TEXT PRIMARY KEY, generation TEXT NOT NULL)");
  const insert = db.prepare(
      "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, 'active', '2026-11-05T00:00:00.000Z')",
    ),
    lease = db.prepare(
      "INSERT INTO lease_interval(task_id, execution_id, acquired_revision, released_revision, holder_json, previous_holder_json, lease_expires_at, reason) VALUES (?, ?, ?, NULL, '{}', NULL, '2999-01-01T00:00:00.000Z', 'test')",
    ),
    snapshot = JSON.stringify({ task: { title: "active", pinned: false } });
  for (let index = 0; index < 1_000; index += 1)
    insert.run(`task_${String(index).padStart(4, "0")}`, index + 1, snapshot);
  lease.run("task_0007", "execution_7", 1);

  const leased = listTaskRowsNarrow(db, { status: "active", leaseOnly: true, limit: 50 }),
    all = listTaskRowsNarrow(db, { status: "active", limit: 50 });
  assert.deepEqual(
    leased.rows.map((row) => row.task_id),
    ["task_0007"],
  );
  assert.equal(all.page?.nextCursor !== null, true);
  db.close();
});
