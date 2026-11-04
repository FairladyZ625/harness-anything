// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDecision, projectionFixture, proposal } from "./relation-graph-projection.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";
import {
  assertRuntimeDispatchKeyIndexReady,
  ensureRuntimeMemberIndex,
} from "../../src/projection/runtime-member-index.ts";
import { REPOSITORY_READ_TABLES_SQL } from "../../src/projection/projection-tables.ts";

test("SQLite task point reads remain indexed through the member expansion", (t) => {
  const db = new DatabaseSync(":memory:"),
    plans: Record<string, unknown> = {},
    explain = () => db.prepare("EXPLAIN QUERY PLAN SELECT task_id FROM event_index WHERE task_id=?").all("task");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    plans.before = explain();
    db.exec("ALTER TABLE event_index ADD COLUMN runtime_session_present INTEGER");
    plans.afterColumn = explain();
    ensureRuntimeMemberIndex(db);
    plans.afterExpansion = explain();
    t.diagnostic(`SQLITE_TASK_POINT_PLANS ${JSON.stringify(plans)}`);
    for (const plan of Object.values(plans) as { detail: string }[][]) {
      assert.ok(plan.some(({ detail }) => /SEARCH event_index .*\(task_id=\?\)/u.test(detail)));
      assert.ok(plan.every(({ detail }) => !/SCAN event_index/u.test(detail)));
    }
  } finally {
    db.close();
  }
});

test("SQLite dispatch key expansion backfills both historical and current spellings", (t) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    const insert = db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)"),
      dispatch = (payload: Readonly<Record<string, unknown>>) =>
        JSON.stringify({ schema: "agent-runtime-event/v1", type: "runtime_dispatch_requested", payload });
    insert.run("old", 1, dispatch({ dispatchId: "dispatch-old", idempotencyKey: "key-old" }));
    insert.run("new", 2, dispatch({ dispatchId: "dispatch-new", dispatchKey: "key-new" }));
    insert.run("task", 3, JSON.stringify({ schema: "task-event/v1", type: "task_created", payload: {} }));
    const progress: { applied: number; total: number }[] = [];
    ensureRuntimeMemberIndex(db, (entry) => progress.push(entry));
    assert.deepEqual(
      db
        .prepare("SELECT op_id,dispatch_key FROM event_index ORDER BY workspace_revision")
        .all()
        .map((row) => ({ opId: String(row.op_id), dispatchKey: String(row.dispatch_key) })),
      [
        { opId: "old", dispatchKey: "key-old" },
        { opId: "new", dispatchKey: "key-new" },
        { opId: "task", dispatchKey: "" },
      ],
    );
    assert.deepEqual(progress, [{ applied: 3, total: 3 }]);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT event_json FROM event_index WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1' AND json_extract(event_json, '$.type') = 'runtime_dispatch_requested' AND dispatch_key = ? ORDER BY workspace_revision LIMIT 1",
      )
      .all("key-old") as readonly { readonly detail: string }[];
    t.diagnostic(`SQLITE_DISPATCH_KEY_PLAN ${JSON.stringify(plan)}`);
    assert.match(
      plan.map(({ detail }) => detail).join("\n"),
      /SEARCH event_index USING INDEX event_index_runtime_dispatch_key/u,
    );
    assert.doesNotThrow(() => assertRuntimeDispatchKeyIndexReady(db));
    // Old prepared statements and mixed-version writers insert only the original columns; the
    // AFTER INSERT trigger still derives the key.
    insert.run("after", 4, dispatch({ dispatchId: "dispatch-after", idempotencyKey: "key-after" }));
    assert.equal(
      db.prepare("SELECT dispatch_key FROM event_index WHERE op_id='after'").all()[0]!.dispatch_key,
      "key-after",
    );
    db.exec("UPDATE event_index SET dispatch_key=NULL WHERE op_id='old'");
    assert.throws(() => assertRuntimeDispatchKeyIndexReady(db), { code: "projection_pending" });
  } finally {
    db.close();
  }
});

test("SQLite member reads skip duplicate and orphan dispatch history", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = projectionFixture(rootDir);
    applyDecision(fixture, proposal(1, "dec_MEMBER_INDEX"));
    const { projection } = fixture,
      db = new DatabaseSync(projection.path);
    try {
      const insert = db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES(?,?,?)");
      db.exec("BEGIN");
      for (let n = 1; n <= 100002; n++)
        insert.run(
          `dispatch-${n}`,
          n + 1,
          JSON.stringify({
            schema: "agent-runtime-event/v1",
            type: "runtime_dispatch_requested",
            workspaceRevision: n + 1,
            eventId: `dispatch-${n}`,
            opId: `dispatch-${n}`,
            actor: { principal: { personId: "test" }, executor: null },
            source: "local",
            occurredAt: "2026-11-04",
            payload: {
              dispatchId: `dispatch-${String(n).padStart(6, "0")}`,
              runtimeSessionId: n <= 50000 ? `orphan-${n}` : n === 100002 ? "session-b" : "session-a",
              agentId: "agent-target",
              squadId: "squad-target",
              startedAt: "2026-11-04",
              dispatchKey: `key-${n}`,
            },
          }),
        );
      for (const id of ["session-a", "session-b"])
        db.prepare("INSERT INTO runtime_session(runtime_session_id,workspace_revision,value_json) VALUES(?,1,?)").run(
          id,
          JSON.stringify({ runtimeSessionId: id, taskBindings: [] }),
        );
      db.exec("COMMIT; ANALYZE");
      const queries: { sql: string; plan: { detail: string }[] }[] = [],
        prepare = DatabaseSync.prototype.prepare;
      const guard = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (!/FROM event_index/u.test(sql)) return Reflect.apply(prepare, this, [sql]);
        const plan = Reflect.apply(prepare, this, [`EXPLAIN QUERY PLAN ${sql}`]),
          statement = Reflect.apply(prepare, this, [sql]);
        return new Proxy(statement, {
          get(target, key) {
            if (key === "all")
              return (...values: unknown[]) => {
                queries.push({ sql, plan: Reflect.apply(plan.all, plan, values) });
                return Reflect.apply(target.all, target, values);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      try {
        for (const member of [{ agentId: "agent-target" }, { squadId: "squad-target" }]) {
          const page = projection.readRuntimeDispatchesByMember({ ...member, limit: 1 });
          assert.equal(page.rows.length, 1);
          assert.equal(page.truncated, true);
          assert.deepEqual(
            page.sessions.map((row) => row.runtimeSessionId),
            ["session-a", "session-b"],
          );
        }
        t.diagnostic(`SQLITE_MEMBER_PLANS ${JSON.stringify(queries)}`);
        assert.ok(queries.length >= 4);
        for (const query of queries) {
          assert.ok(
            query.plan.every(
              ({ detail }) =>
                !/\bSCAN d\b/u.test(detail) &&
                (!/\bSCAN event_index\b/u.test(detail) ||
                  /USING INDEX event_index_runtime_member_pending/u.test(detail)) &&
                !/CO-ROUTINE \(subquery/u.test(detail) &&
                (query.sql.startsWith("WITH RECURSIVE") || !/USE TEMP B-TREE/u.test(detail)),
            ),
            `member read scans/sorts historical dispatches: ${JSON.stringify(query)}`,
          );
          if (query.sql.startsWith("WITH RECURSIVE"))
            assert.ok(
              query.plan.some(({ detail }) => /SEARCH d .*\((?:workspace_revision|rowid)=\?/u.test(detail)),
              `selected dispatch revisions must use point lookups: ${JSON.stringify(query)}`,
            );
        }
      } finally {
        guard.mock.restore();
      }
      db.exec("UPDATE event_index SET runtime_session_present=NULL");
      assert.throws(() => projection.readRuntimeDispatchesByMember({ agentId: "agent-target", limit: 1 }), {
        code: "projection_pending",
      });
      const progress: number[] = [];
      ensureRuntimeMemberIndex(db, ({ applied }) => progress.push(applied));
      assert.equal(progress.at(-1), 100003);
      assert.ok(progress.every((n, i) => n - (progress[i - 1] ?? 0) <= 64));
      const read = () =>
        projection
          .readRuntimeDispatchesByMember({ agentId: "agent-target", limit: 1 })
          .sessions.map((row) => row.runtimeSessionId);
      assert.deepEqual(read(), ["session-a", "session-b"]);
      db.prepare("INSERT INTO runtime_session(runtime_session_id,workspace_revision,value_json) VALUES(?,1,?)").run(
        "orphan-1",
        JSON.stringify({ runtimeSessionId: "orphan-1", taskBindings: [] }),
      );
      assert.deepEqual(read(), ["orphan-1", "session-a", "session-b"]);
      db.prepare("DELETE FROM runtime_session WHERE runtime_session_id=?").run("orphan-1");
      assert.deepEqual(read(), ["session-a", "session-b"]);
      ensureRuntimeMemberIndex(db, () => assert.fail("ready expansion visited historical rows"));
    } finally {
      db.close();
      projection.close();
    }
  });
});
