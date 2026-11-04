// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDecision, projectionFixture, proposal } from "./relation-graph-projection.fixtures.ts";
import { withTempStoreAsync } from "./helpers.ts";

test("SQLite runtime pages seek past history, peek once, and retain opt-in exact counts", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = projectionFixture(rootDir);
    applyDecision(fixture, proposal(1, "dec_SESSION_PAGES"));
    const { projection } = fixture,
      db = new DatabaseSync(projection.path);
    try {
      const insert = db.prepare(
          "INSERT INTO runtime_session(runtime_session_id,workspace_revision,value_json) VALUES(?,1,?)",
        ),
        bind = db.prepare("INSERT INTO runtime_session_task_binding VALUES(?,?,?,'2026-11-04')");
      db.exec("BEGIN");
      for (let n = 1; n <= 100200; n++) {
        const id = `session-${String(n).padStart(6, "0")}`;
        insert.run(id, JSON.stringify({ runtimeSessionId: id }));
        bind.run(n > 100000 ? "target" : "history", id, "execution-a");
        if (n > 100000) bind.run("target", id, "execution-b");
      }
      db.exec("COMMIT; ANALYZE");
      const queries: { sql: string; plan: { detail: string }[] }[] = [],
        prepare = DatabaseSync.prototype.prepare,
        guard = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
          if (/FROM runtime_session/u.test(sql)) {
            const plan = Reflect.apply(prepare, this, [`EXPLAIN QUERY PLAN ${sql}`]);
            const explain = (...values: unknown[]) =>
              queries.push({ sql, plan: Reflect.apply(plan.all, plan, values) });
            const statement = Reflect.apply(prepare, this, [sql]);
            return new Proxy(statement, {
              get(target, key) {
                if (key === "all")
                  return (...values: unknown[]) => {
                    explain(...values);
                    return Reflect.apply(target.all, target, values);
                  };
                const value: unknown = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          }
          return Reflect.apply(prepare, this, [sql]);
        });
      try {
        const first = projection.readRuntimeSessionPage({ limit: 64, afterRuntimeSessionId: "session-000000" }),
          task = projection.readRuntimeSessionPage({
            taskId: "target",
            limit: 64,
            afterRuntimeSessionId: "session-100000",
          }),
          last = projection.readRuntimeSessionPage({
            taskId: "target",
            limit: 64,
            afterRuntimeSessionId: "session-100192",
          });
        assert.equal(first.rows.length, 64);
        assert.equal(first.remainingCount, null);
        assert.equal(first.nextRuntimeSessionId, "session-000064");
        assert.equal(task.rows.length, 64);
        assert.equal(task.nextRuntimeSessionId, "session-100064");
        assert.equal(last.rows.length, 8);
        assert.equal(last.remainingCount, 0);
        assert.equal(last.nextRuntimeSessionId, null);
        assert.ok(queries.length >= 3);
        for (const query of queries) {
          assert.doesNotMatch(query.sql, /COUNT\s*\(/iu);
          assert.ok(
            query.plan.some(({ detail }) => /SEARCH runtime_session.*runtime_session_id>\?/u.test(detail)),
            JSON.stringify(query),
          );
          assert.ok(
            query.plan.every(({ detail }) => !/USE TEMP B-TREE/u.test(detail)),
            JSON.stringify(query),
          );
        }
        t.diagnostic(`SQLITE_SESSION_PAGE ${JSON.stringify(queries)}`);
        assert.equal(
          projection.readRuntimeSessionPage({ taskId: "target", limit: 64, includeRemainingCount: true })
            .remainingCount,
          136,
        );
        assert.equal(
          projection.readRuntimeSessionPage({ limit: 64, includeRemainingCount: true }).remainingCount,
          100136,
        );
      } finally {
        guard.mock.restore();
      }
    } finally {
      db.close();
      projection.close();
    }
  });
});
