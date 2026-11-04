// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDecision, projectionFixture, proposal } from "./relation-graph-projection.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { ensureRuntimeMemberIndex } from "../../src/projection/runtime-member-index.ts";

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
        db.prepare("INSERT INTO runtime_session VALUES(?,1,?)").run(
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
        for (const query of queries)
          assert.ok(
            query.plan.every(
              ({ detail }) =>
                !/CO-ROUTINE \(subquery/u.test(detail) &&
                (query.sql.startsWith("WITH RECURSIVE") || !/USE TEMP B-TREE/u.test(detail)),
            ),
            `member read scans/sorts historical dispatches: ${JSON.stringify(query)}`,
          );
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
      db.prepare("INSERT INTO runtime_session VALUES(?,1,?)").run(
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
