// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REPOSITORY_READ_TABLES_SQL, createProjectionTables } from "../../src/projection/projection-tables.ts";
import { ensureRuntimeMemberIndex, backfillRuntimeReadIndexPage } from "../../src/projection/runtime-member-index.ts";
import { readLatestInterval } from "../../src/projection/rebuildable-task-projection-runtime.ts";
import { countSqliteWork } from "./sqlite-work-counter.fixture.ts";

test("read-index expansion has constant SQL work at 10000 and 100000 events", (t) => {
  const measurements = [];
  for (const events of [10000, 100000]) {
    const db = new DatabaseSync(":memory:");
    db.exec(REPOSITORY_READ_TABLES_SQL);
    const insert = db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)");
    db.exec("BEGIN");
    for (let n = 1; n <= events; n++)
      insert.run(
        `op-${n}`,
        n,
        JSON.stringify({
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          occurredAt: "2026-11-05",
          payload: {
            dispatchId: `dispatch-${n}`,
            runtimeSessionId: `session-${n}`,
            dispatchKey: `key-${n}`,
            agentId: "agent",
            squadId: "squad",
          },
        }),
      );
    db.exec("COMMIT");
    const work = countSqliteWork(t);
    try {
      ensureRuntimeMemberIndex(db);
      const attach = work.totals("attach");
      work.phase("page");
      const page = backfillRuntimeReadIndexPage(db);
      measurements.push({
        events,
        attach,
        page,
        pageWork: work.totals("page"),
        indexes: work.statements.filter((row) => row.indexInputRows > 0),
      });
    } finally {
      work.stop();
      db.close();
    }
  }
  t.diagnostic(`READ_INDEX_PHASE_COUNTS ${JSON.stringify(measurements)}`);
  for (const row of measurements) {
    assert.equal(row.attach.indexInputRows, 0, "attach must not build an index over historical rows");
    assert.deepEqual(row.page, { processed: 64, done: false });
  }
  assert.equal(measurements[0]!.attach.returnedRows, measurements[1]!.attach.returnedRows);
  assert.equal(measurements[0]!.attach.statements, measurements[1]!.attach.statements);
  assert.equal(measurements[0]!.pageWork.returnedRows, measurements[1]!.pageWork.returnedRows);
});

test("counter detects the previous column migration's populated-index work", (t) => {
  const counts = [];
  for (const events of [10000, 100000]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE event_index(workspace_revision INTEGER PRIMARY KEY,event_json TEXT,dispatch_key TEXT)");
      const insert = db.prepare("INSERT INTO event_index VALUES(?,?,NULL)");
      db.exec("BEGIN");
      for (let n = 1; n <= events; n++)
        insert.run(
          n,
          JSON.stringify({
            schema: "agent-runtime-event/v1",
            type: "runtime_dispatch_requested",
            payload: { dispatchKey: `key-${n}` },
          }),
        );
      db.exec("COMMIT");
      const work = countSqliteWork(t);
      try {
        // Exactly the two missing indexes in cb18d857's daemon upgrade fixture. This is a
        // positive control for the counter, not an alternate production implementation.
        db.prepare(
          "CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_key_pending ON event_index(workspace_revision) WHERE dispatch_key IS NULL",
        ).run();
        db.prepare(
          "CREATE INDEX IF NOT EXISTS event_index_runtime_dispatch_key ON event_index(dispatch_key,workspace_revision) WHERE json_extract(event_json,'$.schema')='agent-runtime-event/v1' AND json_extract(event_json,'$.type')='runtime_dispatch_requested'",
        ).run();
        counts.push({ events, ...work.totals("attach") });
      } finally {
        work.stop();
      }
    } finally {
      db.close();
    }
  }
  t.diagnostic(`LEGACY_COLUMN_INDEX_COUNTS ${JSON.stringify(counts)}`);
  for (const row of counts) assert.equal(row.indexInputRows, 2 * row.events);
});

test("latest lease acquisition builds outside attach and seeks across 10000/100000 historical intervals", (t) => {
  const measurements = [];
  for (const size of [10000, 100000]) {
    const work = countSqliteWork(t),
      db = new DatabaseSync(":memory:");
    try {
      createProjectionTables(db);
      assert.deepEqual(readLatestInterval(db, "missing"), { status: "ready", interval: null });
      db.exec("DROP INDEX lease_interval_task_revision; BEGIN");
      const insert = db.prepare(`INSERT INTO lease_interval(task_id,execution_id,acquired_revision,
        released_revision,holder_json,lease_expires_at,reason) VALUES('target',?,?,NULL,'{}','2099','start')`);
      for (let n = 1; n <= size; n++) insert.run(`execution-${n % 17}`, n);
      db.exec("COMMIT");
      work.statements.length = 0;
      try {
        const start = performance.now();
        ensureRuntimeMemberIndex(db);
        const attachMs = performance.now() - start;
        assert.deepEqual(readLatestInterval(db, "target"), {
          status: "pending",
          progress: "index=lease_interval_task_revision",
        });
        const attach = work.totals("attach");
        assert.equal(attach.indexInputRows, 0);
        work.phase("background");
        const execute = db.exec.bind(db),
          rollback = new Error("injected lease index commit failure");
        const fault = t.mock.method(db, "exec", (sql: string) => {
          if (sql === "COMMIT") throw rollback;
          return execute(sql);
        });
        assert.throws(
          () => backfillRuntimeReadIndexPage(db),
          (error) => error === rollback,
        );
        fault.mock.restore();
        assert.equal(readLatestInterval(db, "target").status, "pending");
        assert.deepEqual(backfillRuntimeReadIndexPage(db), { processed: 0, done: false });
        const rootpage = db
          .prepare("SELECT rootpage FROM sqlite_master WHERE name='lease_interval_task_revision'")
          .get()!.rootpage;
        ensureRuntimeMemberIndex(db);
        assert.deepEqual(backfillRuntimeReadIndexPage(db), { processed: 0, done: true });
        assert.equal(
          db.prepare("SELECT rootpage FROM sqlite_master WHERE name='lease_interval_task_revision'").get()!.rootpage,
          rootpage,
        );
        work.phase("latest");
        const latest = readLatestInterval(db, "target");
        assert.equal(latest.status, "ready");
        assert.equal(latest.interval!.acquiredRevision, size);
        assert.equal(latest.interval!.executionId, `execution-${size % 17}`);
        const read = work.totals("latest");
        assert.equal(read.returnedRows, 3, "two catalog points and one lease, including cached statements");
        const plan = db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM lease_interval WHERE task_id=? ORDER BY acquired_revision DESC LIMIT 1",
          )
          .all("target");
        assert.match(JSON.stringify(plan), /USING INDEX lease_interval_task_revision/u);
        assert.doesNotMatch(JSON.stringify(plan), /SCAN lease_interval|TEMP B-TREE/u);
        db.prepare("UPDATE lease_interval SET released_revision=? WHERE acquired_revision=?").run(size + 1, size);
        const released = readLatestInterval(db, "target");
        assert.equal(released.status, "ready");
        assert.equal(
          released.interval!.releasedRevision,
          size + 1,
          "latest released acquisition must not fall back to an older open interval",
        );
        measurements.push({ size, attachMs, attach, read, plan });
      } finally {
        work.stop();
      }
    } finally {
      work.stop();
      db.close();
    }
  }
  assert.equal(measurements[0]!.read.returnedRows, measurements[1]!.read.returnedRows);
  t.diagnostic(`LATEST_LEASE_SQLITE ${JSON.stringify(measurements)}`);
});
