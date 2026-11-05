// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { REPOSITORY_READ_TABLES_SQL } from "../../src/projection/projection-tables.ts";
import { ensureRuntimeMemberIndex, backfillRuntimeReadIndexPage } from "../../src/projection/runtime-member-index.ts";
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
