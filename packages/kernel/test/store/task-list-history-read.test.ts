// harness-test-tier: fast
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TASK_INDEX_TABLES_SQL } from "../../src/projection/projection-tables.ts";
import {
  encodePageCursor,
  listTaskRowsNarrow,
  taskCompletedAtSql,
  taskCreatedAtSql,
} from "../../src/projection/task-query-projection.ts";

/** One page's created_at/completed_at derivations, counted as the rows the two subqueries visit.
 * `event_index` is a view over the real table whose WHERE runs a counting UDF, so the count is the
 * rows SQLite reads for this page while the production SQL stays byte-identical. The count sits in
 * the view's WHERE, not on a projected column, so it cannot steer the seek or a partial index. */
function historyReadCount(db: DatabaseSync): { readonly visits: () => number; readonly reset: () => void } {
  let visits = 0;
  db.function("count_visit", { deterministic: false }, (opId: unknown) => {
    visits += 1;
    return opId;
  });
  return { visits: () => visits, reset: () => (visits = 0) };
}

function seedLedger(db: DatabaseSync, fillerEvents: number, unrelatedTasks: number): void {
  db.exec(TASK_INDEX_TABLES_SQL);
  db.exec(`
    CREATE TABLE event_index_base (
      op_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL UNIQUE,
      task_id TEXT,
      event_json TEXT NOT NULL
    );
    CREATE INDEX event_index_task_id ON event_index_base (task_id);
    CREATE INDEX event_index_task_created ON event_index_base (task_id, workspace_revision);
    CREATE INDEX event_index_task_completed ON event_index_base (task_id, workspace_revision)
      WHERE json_extract(event_json, '$.schema') = 'task-event/v1'
        AND json_extract(event_json, '$.type') = 'task_completed';
    CREATE TABLE task_generation (
      task_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL CHECK (generation IN ('v0', 'v1'))
    );
  `);
  // The production derivations run against this view unchanged.
  db.exec(`
    CREATE VIEW event_index AS
    SELECT op_id, workspace_revision, task_id, event_json FROM event_index_base
    WHERE count_visit(op_id) IS NOT NULL
  `);
  const insertSnapshot = db.prepare(
      "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, ?, ?, ?, ?)",
    ),
    insertPackage = db.prepare("INSERT INTO task_package VALUES (?, ?)"),
    insertEvent = db.prepare("INSERT INTO event_index_base VALUES (?, ?, ?, ?)");
  let revision = 0;
  const task = (taskId: string, status: string) =>
      JSON.stringify({
        task: {
          schema: "task/v2",
          taskId,
          title: `Task ${taskId}`,
          taskClass: "standard",
          status,
          pinned: false,
          metadata: { parentTaskId: null, workKind: "feat", riskTier: "low", urgency: "low", slug: taskId },
        },
      }),
    event = (taskId: string, type: string, occurredAt: string) => {
      revision += 1;
      insertEvent.run(
        `op-${revision}`,
        revision,
        taskId,
        JSON.stringify({
          schema: "task-event/v1",
          eventId: `event-${revision}`,
          workspaceRevision: revision,
          opId: `op-${revision}`,
          taskId,
          type,
          actor: { principal: { personId: "history" }, executor: null },
          source: "local",
          occurredAt,
          payload: { mutation: { command: "amend", reason: "fixture", fields: [] }, documentClaims: [] },
        }),
      );
    };
  // "a-long-history" sorts first, so it is on every first page measured here.
  insertSnapshot.run("a-long-history", 1, task("a-long-history", "active"), "active", "2026-01-01T00:00:00.000Z");
  insertPackage.run("a-long-history", "tasks/a-long-history");
  event("a-long-history", "task_created", "2026-01-01T00:00:00.000Z");
  for (let index = 0; index < fillerEvents; index += 1)
    event("a-long-history", "task_amended", "2026-01-02T00:00:00.000Z");
  event("a-long-history", "task_completed", "2026-01-03T00:00:00.000Z");
  for (let index = 0; index < unrelatedTasks; index += 1) {
    const taskId = `b-unrelated-${String(index).padStart(5, "0")}`;
    insertSnapshot.run(
      taskId,
      revision,
      task(taskId, index % 2 === 0 ? "active" : "done"),
      index % 2 === 0 ? "active" : "done",
      "2026-01-04T00:00:00.000Z",
    );
    insertPackage.run(taskId, `tasks/${taskId}`);
    event(taskId, "task_created", "2026-01-04T00:00:00.000Z");
    event(taskId, "task_completed", "2026-01-05T00:00:00.000Z");
  }
}

test("a task list page reads two event rows per row, not that task's whole history", (t) => {
  const measure = (fillerEvents: number, unrelatedTasks: number) => {
    const db = new DatabaseSync(":memory:");
    try {
      const counter = historyReadCount(db);
      seedLedger(db, fillerEvents, unrelatedTasks);
      counter.reset();
      const listed = listTaskRowsNarrow(db, { limit: 5 });
      return {
        visits: counter.visits(),
        ids: listed.rows.map(({ task_id }) => task_id),
        createdAt: listed.rows[0]?.created_at,
        completedAt: listed.rows[0]?.completed_at,
      };
    } finally {
      db.close();
    }
  };
  // The same page, twice per axis: one task's history grows, then the task population grows.
  const small = measure(0, 20),
    longHistory = measure(50_000, 20),
    manyTasks = measure(0, 2_000);
  assert.deepEqual(small.ids, longHistory.ids);
  assert.deepEqual(longHistory.ids, manyTasks.ids);
  // created_at is the task's first event and completed_at its completion, not its last amendment:
  // the values a whole-history scan would also produce, so the equality pins the seek's result.
  assert.equal(small.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(small.completedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(longHistory.createdAt, small.createdAt);
  assert.equal(longHistory.completedAt, small.completedAt);
  // 50k extra amendment events on one task must not add a single row read. Without the revision
  // order in the index this page visits all 50,002 events of that task instead of two.
  assert.equal(
    longHistory.visits,
    small.visits,
    `50k extra events on one task changed the page's event reads from ${small.visits} to ${longHistory.visits}`,
  );
  assert.equal(
    manyTasks.visits,
    small.visits,
    `2,000 extra tasks changed the page's event reads from ${small.visits} to ${manyTasks.visits}`,
  );
  t.diagnostic(
    `event rows read for one page: ${small.visits} at 20 tasks, ${longHistory.visits} at 20 tasks + 50k events, ${manyTasks.visits} at 2,020 tasks`,
  );
});

test("the created and completion derivations seek the indexed revision order", (t) => {
  const db = new DatabaseSync(":memory:");
  try {
    const counter = historyReadCount(db);
    seedLedger(db, 1_000, 5);
    for (const [label, sql] of [
      ["created_at", `SELECT ${taskCreatedAtSql("task_snapshot.task_id")} FROM task_snapshot WHERE task_id = ?`],
      ["completed_at", `SELECT ${taskCompletedAtSql("task_snapshot.task_id")} FROM task_snapshot WHERE task_id = ?`],
    ] as const) {
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("a-long-history") as unknown as readonly { detail: string }[]
      )
        .map(({ detail }) => detail)
        .join("\n");
      t.diagnostic(`${label} plan: ${plan.replaceAll("\n", " / ")}`);
      // The seek must ride the revision-ordered index and must not sort: a TEMP B-TREE here means
      // SQLite read the task's whole history to return its first row.
      assert.match(plan, /USING (?:COVERING )?INDEX event_index_task_(?:created|completed)/u);
      assert.doesNotMatch(plan, /USE TEMP B-TREE/u);
      assert.doesNotMatch(plan, /SCAN (?:origin|completion)/u);
    }
    // A one-row page reads two task rows (the extra row is the nextCursor probe) and derives
    // created_at and completed_at for each: exactly four event rows, not the task's 1,002.
    counter.reset();
    const listed = listTaskRowsNarrow(db, { limit: 1 });
    assert.equal(listed.rows[0]?.task_id, "a-long-history");
    assert.equal(counter.visits(), 4);
  } finally {
    db.close();
  }
});

test("a page cursor continues past the long-history task without re-reading its history", (t) => {
  const db = new DatabaseSync(":memory:");
  try {
    const counter = historyReadCount(db);
    seedLedger(db, 5_000, 30);
    const first = listTaskRowsNarrow(db, { limit: 3 });
    counter.reset();
    const second = listTaskRowsNarrow(db, { limit: 3, cursor: encodePageCursor([first.rows.at(-1)!.task_id]) });
    assert.equal(first.rows.length, 3);
    assert.equal(second.rows.length, 3);
    assert.ok(
      second.rows.every(({ task_id }) => task_id > first.rows.at(-1)!.task_id),
      "the cursor page continues in task id order",
    );
    // Four task rows behind the cursor (three plus the nextCursor probe), two derived events each;
    // the 5,001-event task is behind the cursor and contributes nothing.
    assert.equal(counter.visits(), 8);
    t.diagnostic(`second page event rows read: ${counter.visits()}`);
    assert.equal(first.page?.nextCursor === null, false);
  } finally {
    db.close();
  }
});
