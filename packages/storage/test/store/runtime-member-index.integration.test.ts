// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDecision, projectionFixture, proposal } from "./relation-graph-projection.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";
import {
  backfillRuntimeReadIndexPage,
  runtimeReadIndexReady,
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
    assert.equal(runtimeReadIndexReady(db), true, "a new empty cache never needs the legacy reader");
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

test("index expansion atomically replaces an old completion marker and retires history writers", (t) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(REPOSITORY_READ_TABLES_SQL);
    db.exec(`CREATE TABLE runtime_read_index_progress(singleton INTEGER PRIMARY KEY,revision INTEGER,complete INTEGER);
      INSERT INTO runtime_read_index_progress VALUES(1,1,1);
      CREATE TRIGGER runtime_dispatch_session_present AFTER INSERT ON runtime_session BEGIN
        SELECT RAISE(ABORT,'obsolete history writer'); END`);
    db.prepare("INSERT INTO event_index(op_id,workspace_revision,event_json) VALUES('old',1,?)").run(
      JSON.stringify({
        schema: "agent-runtime-event/v1",
        type: "runtime_dispatch_requested",
        payload: {
          dispatchId: "old",
          dispatchKey: "key",
          runtimeSessionId: "session",
          agentId: "agent",
        },
      }),
    );
    const prepare = db.prepare,
      fault = t.mock.method(db, "prepare", function (sql: string) {
        if (sql.includes("CREATE INDEX IF NOT EXISTS runtime_dispatch_session"))
          throw new Error("injected DDL failure");
        return Reflect.apply(prepare, db, [sql]);
      });
    try {
      assert.throws(() => ensureRuntimeMemberIndex(db), /injected DDL failure/u);
    } finally {
      fault.mock.restore();
    }
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_dispatch_index'").get(), undefined);
    assert.equal(db.prepare("SELECT complete FROM runtime_read_index_progress").get()!.complete, 1);
    ensureRuntimeMemberIndex(db);
    assert.equal(runtimeReadIndexReady(db), false, "the old complete marker cannot publish an empty new index");
    assert.deepEqual(backfillRuntimeReadIndexPage(db), { processed: 1, done: false });
    while (!backfillRuntimeReadIndexPage(db).done) {
      /* finish physical builds */
    }
    ensureRuntimeMemberIndex(db);
    assert.equal(runtimeReadIndexReady(db), true, "reopening must retain completed progress");
    db.prepare(
      "INSERT INTO runtime_session(runtime_session_id,workspace_revision,value_json) VALUES('session',1,'{}')",
    ).run();
    assert.equal(
      db.prepare("SELECT runtime_session_present FROM runtime_dispatch_index").get()!.runtime_session_present,
      1,
    );
    db.exec("DELETE FROM runtime_session");
    assert.equal(
      db.prepare("SELECT runtime_session_present FROM runtime_dispatch_index").get()!.runtime_session_present,
      0,
    );
    db.prepare("UPDATE event_index SET event_json=? WHERE workspace_revision=1").run(
      JSON.stringify({ schema: "task-event/v1", type: "task_created" }),
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM runtime_dispatch_index").get()!.n, 0);
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
    ensureRuntimeMemberIndex(db);
    assert.equal(runtimeReadIndexReady(db), false);
    for (;;) {
      const page = backfillRuntimeReadIndexPage(db);
      if (page.done) break;
      if (page.processed) progress.push({ applied: (progress.at(-1)?.applied ?? 0) + page.processed, total: 3 });
    }
    assert.deepEqual(
      db
        .prepare(
          "SELECT e.op_id,COALESCE(r.dispatch_key,'') AS dispatch_key FROM event_index e LEFT JOIN runtime_dispatch_index r USING(workspace_revision) ORDER BY e.workspace_revision",
        )
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
        "EXPLAIN QUERY PLAN SELECT e.event_json FROM runtime_dispatch_index r CROSS JOIN event_index e USING(workspace_revision) WHERE r.dispatch_key=? ORDER BY r.workspace_revision LIMIT 1",
      )
      .all("key-old") as readonly { readonly detail: string }[];
    t.diagnostic(`SQLITE_DISPATCH_KEY_PLAN ${JSON.stringify(plan)}`);
    assert.match(plan.map(({ detail }) => detail).join("\n"), /SEARCH r USING COVERING INDEX runtime_dispatch_key/u);
    assert.equal(runtimeReadIndexReady(db), true);
    // Old prepared statements and mixed-version writers insert only the original columns; the
    // AFTER INSERT trigger still derives the key.
    insert.run("after", 4, dispatch({ dispatchId: "dispatch-after", idempotencyKey: "key-after" }));
    assert.equal(
      db.prepare("SELECT dispatch_key FROM runtime_dispatch_index WHERE workspace_revision=4").all()[0]!.dispatch_key,
      "key-after",
    );
    db.exec("DELETE FROM runtime_dispatch_index WHERE workspace_revision=1");
    db.exec("UPDATE runtime_read_index_progress SET revision=0,complete=0");
    assert.equal(runtimeReadIndexReady(db), false);
    assert.equal(backfillRuntimeReadIndexPage(db).processed, 4);
    assert.equal(
      db.prepare("SELECT dispatch_key FROM runtime_dispatch_index WHERE workspace_revision=1").get()!.dispatch_key,
      "key-old",
    );
    assert.equal(backfillRuntimeReadIndexPage(db).done, true);
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
        if (!/FROM (?:event_index|runtime_dispatch_index)/u.test(sql)) return Reflect.apply(prepare, this, [sql]);
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
                !/\bSCAN (?:d|r|runtime_dispatch_index)\b/u.test(detail) &&
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
      db.exec("DELETE FROM runtime_dispatch_index");
      db.exec("UPDATE runtime_read_index_progress SET revision=0,complete=0");
      assert.throws(() => projection.readRuntimeDispatchesByMember({ agentId: "agent-target", limit: 1 }), {
        code: "projection_pending",
        message: /progress/u,
      });
      const progress: number[] = [];
      for (;;) {
        const page = backfillRuntimeReadIndexPage(db);
        if (page.done) break;
        progress.push((progress.at(-1) ?? 0) + page.processed);
      }
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
      ensureRuntimeMemberIndex(db);
      assert.deepEqual(backfillRuntimeReadIndexPage(db), { processed: 0, done: true });
    } finally {
      db.close();
      projection.close();
    }
  });
});
