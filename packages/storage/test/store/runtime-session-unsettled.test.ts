// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

const settledCount = 2000;

function session(runtimeSessionId: string, outcome: string | null) {
  return {
    runtimeSessionId,
    instanceId: "deepseek-worker",
    installationId: "installation-deepseek",
    kindId: "deepseek-harness",
    definitionSnapshotRef: "artifact:runtime-definitions/deepseek/v1",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 1,
    liveness: outcome === null ? "unknown" : "exited",
    attachable: false,
    taskBindings: [],
    outcome,
    exitCode: outcome === null ? null : 0,
    resultRef: null,
    lastObservedAt: "2026-11-01T00:00:00.000Z",
  };
}

test("unsettled-only runtime read filters in SQL and an existing projection picks up its index", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "runtime-unsettled-read", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.catchUp();
    const projectionPath = projection.path;
    projection.close();

    // Simulate the deployed shape this task repairs: an existing projection written before the
    // index existed, with a long settled history and a handful of sessions still running.
    const db = new DatabaseSync(projectionPath);
    db.exec("DROP INDEX IF EXISTS runtime_session_unsettled");
    const insert = db.prepare(
      "INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json) VALUES (?, ?, ?)",
    );
    for (let index = 0; index < settledCount; index += 1) {
      const runtimeSessionId = `runtime-settled-${String(index).padStart(5, "0")}`;
      insert.run(runtimeSessionId, index + 1, JSON.stringify(session(runtimeSessionId, "succeeded")));
    }
    for (const runtimeSessionId of ["runtime-open-a", "runtime-open-b"]) {
      insert.run(runtimeSessionId, settledCount + 1, JSON.stringify(session(runtimeSessionId, null)));
    }
    db.close();

    // Reopening runs the idempotent table/index DDL against the pre-existing file, exactly as the
    // daemon's next start does after this build replaces the previous one.
    const reopened = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(
      reopened.readRuntimeSessions({ unsettledOnly: true }).map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-open-a", "runtime-open-b"],
    );
    assert.equal(reopened.readRuntimeSessions().length, settledCount + 2);
    assert.deepEqual(
      reopened
        .readRuntimeSessions({ runtimeSessionId: "runtime-settled-00000" })
        .map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-settled-00000"],
    );
    assert.deepEqual(reopened.readRuntimeSessions({ runtimeSessionId: "runtime-missing" }), []);
    assert.deepEqual(
      reopened.readRuntimeSessions({ runtimeSessionId: "runtime-settled-00000", unsettledOnly: true }),
      [],
    );
    assert.deepEqual(
      reopened
        .readRuntimeSessions({ runtimeSessionId: "runtime-open-a", unsettledOnly: true })
        .map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-open-a"],
    );
    reopened.close();

    // The read stays proportional to unsettled sessions only if SQLite answers it from the index;
    // a plan that scans runtime_session would restore the O(history) startup cost.
    const planDb = new DatabaseSync(projectionPath, { readOnly: true });
    const plan = planDb
      .prepare(
        [
          "EXPLAIN QUERY PLAN",
          "SELECT value_json FROM runtime_session",
          "WHERE json_extract(value_json, '$.outcome') IS NULL ORDER BY runtime_session_id",
        ].join(" "),
      )
      .all();
    planDb.close();
    assert.match(
      plan.map(({ detail }) => String(detail)).join("\n"),
      /runtime_session_unsettled/,
      `unsettled read must use runtime_session_unsettled: ${JSON.stringify(plan)}`,
    );

    await store.drain();
  });
});
