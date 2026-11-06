// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore, canonicalEventWritePlan } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

const settledCount = 2000;
const foreignUnsettledCount = 300;

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

test("unsettled-only runtime read stays index-bounded and scopes its own node", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "runtime-unsettled-read", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.catchUp();
    const projectionPath = projection.path;
    projection.close();

    // Simulate the deployed shape: a projection written before both the ordered index and the
    // execution-owner column existed, with a long settled history, long same-node dispatch
    // history, and many unsettled sessions on another node.
    const db = new DatabaseSync(projectionPath);
    db.exec("DROP TABLE runtime_session");
    db.exec(`CREATE TABLE runtime_session (
      runtime_session_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL,
      value_json TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX runtime_session_unsettled ON runtime_session(json_extract(value_json, '$.outcome'))");
    db.exec("DELETE FROM projection_maintenance WHERE key = 'runtime-session-execution-node-v1'");
    const insert = db.prepare(
        "INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json) VALUES (?, ?, ?)",
      ),
      insertDispatch = db.prepare(
        "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, ?, ?)",
      );
    let revision = 1;
    const dispatch = (runtimeSessionId: string, nodeId: string) =>
      insertDispatch.run(
        `op-${runtimeSessionId}`,
        revision++,
        null,
        JSON.stringify({
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          source: { kind: "node", nodeId },
          payload: { runtimeSessionId },
        }),
      );
    for (let index = 0; index < settledCount; index += 1) {
      const runtimeSessionId = `runtime-settled-${String(index).padStart(5, "0")}`;
      insert.run(runtimeSessionId, revision++, JSON.stringify(session(runtimeSessionId, "succeeded")));
      dispatch(runtimeSessionId, "node-a");
    }
    for (const runtimeSessionId of ["runtime-open-a", "runtime-open-c"]) {
      insert.run(runtimeSessionId, revision++, JSON.stringify(session(runtimeSessionId, null)));
      dispatch(runtimeSessionId, "node-a");
    }
    for (let index = 0; index < foreignUnsettledCount; index += 1) {
      const runtimeSessionId = `runtime-foreign-${String(index).padStart(5, "0")}`;
      insert.run(runtimeSessionId, revision++, JSON.stringify(session(runtimeSessionId, null)));
      dispatch(runtimeSessionId, "node-b");
    }
    db.close();

    // Reopening runs the idempotent table/index DDL against the pre-existing file, exactly as the
    // daemon's next start does after this build replaces the previous one.
    const reopened = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    const unsettled = reopened
      .readRuntimeSessions({ unsettledOnly: true })
      .map(({ runtimeSessionId }) => runtimeSessionId);
    assert.equal(unsettled.length, 2 + foreignUnsettledCount);
    assert.deepEqual(
      unsettled.filter((id) => id.startsWith("runtime-open-")),
      ["runtime-open-a", "runtime-open-c"],
    );
    assert.deepEqual(
      reopened
        .readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-a" })
        .map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-open-a", "runtime-open-c"],
      "node-a reads its two unsettled sessions, not the 300 on node-b or its 2,000 settled dispatches",
    );
    assert.equal(
      reopened.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-b" }).length,
      foreignUnsettledCount,
    );
    assert.deepEqual(
      reopened.readRuntimeSessions({ runtimeSessionId: "runtime-foreign-00000", executionOwnerNodeId: "node-a" }),
      [],
      "a point read cannot borrow another node's session",
    );
    assert.equal(reopened.readRuntimeSessions().length, settledCount + 2 + foreignUnsettledCount);
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

    // The production query must answer from an index that already carries the outcome filter and
    // the ORDER BY; ANALYZE is deliberately kept so a plan that scans history fails this test.
    const planDb = new DatabaseSync(projectionPath);
    planDb.exec("ANALYZE");
    const plan = planDb
      .prepare(
        [
          "EXPLAIN QUERY PLAN",
          "SELECT value_json FROM runtime_session",
          "WHERE json_extract(value_json, '$.outcome') IS NULL ORDER BY runtime_session_id",
        ].join(" "),
      )
      .all();
    const nodePlan = planDb
      .prepare(
        [
          "EXPLAIN QUERY PLAN",
          "SELECT value_json FROM runtime_session",
          "WHERE execution_node_id = 'node-a'",
          "AND json_extract(value_json, '$.outcome') IS NULL ORDER BY runtime_session_id",
        ].join(" "),
      )
      .all();
    planDb.close();
    const planText = plan.map(({ detail }) => String(detail)).join("\n"),
      nodePlanText = nodePlan.map(({ detail }) => String(detail)).join("\n");
    t.diagnostic(JSON.stringify({ plan: planText, nodePlan: nodePlanText }));
    assert.match(
      planText,
      /SEARCH runtime_session USING INDEX runtime_session_unsettled_order \(<expr>=\?\)/u,
      `unsettled read must seek the ordered index: ${planText}`,
    );
    assert.doesNotMatch(planText, /SCAN runtime_session USING INDEX sqlite_autoindex/u, planText);
    assert.match(
      nodePlanText,
      /SEARCH runtime_session USING INDEX runtime_session_node_unsettled \(execution_node_id=\? AND <expr>=\?\)/u,
      `node scope must seek the owner+outcome index: ${nodePlanText}`,
    );
    assert.doesNotMatch(nodePlanText, /SCAN runtime_session/u, nodePlanText);

    await store.drain();
  });
});

test("a new node-origin session records its execution owner for recovery", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "runtime-owner-write", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    const started = {
      schema: "agent-runtime-event/v1" as const,
      type: "runtime_session_started" as const,
      eventId: "event-runtime-owner-start",
      opId: "operation-runtime-owner-start",
      workspaceRevision: 1,
      occurredAt: "2026-11-04T00:00:00.000Z",
      actor: { executor: null, principal: { personId: "person_owner" } },
      source: { kind: "node" as const, nodeId: "node-a" },
      payload: {
        runtimeSessionId: "runtime-owner-node-a",
        instanceId: "deepseek-worker",
        installationId: "installation-deepseek",
        kindId: "deepseek-harness",
        definitionSnapshotRef: "artifact:runtime-definitions/deepseek/v1",
        launchGeneration: 1,
        attachable: false,
      },
    };
    store.append({
      event: started,
      plan: canonicalEventWritePlan(started, "agent-runtime/v1", started.opId),
      blobs: [],
    });
    projection.catchUp();
    assert.deepEqual(
      projection
        .readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-a" })
        .map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-owner-node-a"],
    );
    assert.deepEqual(projection.readRuntimeSessions({ unsettledOnly: true, executionOwnerNodeId: "node-b" }), []);
    const db = new DatabaseSync(projection.path);
    const row = db
      .prepare("SELECT execution_node_id FROM runtime_session WHERE runtime_session_id = ?")
      .get("runtime-owner-node-a") as { readonly execution_node_id?: string } | undefined;
    db.close();
    assert.equal(row?.execution_node_id, "node-a");
    projection.close();
  });
});

test("a provider-session read seeks its index on a projection written before the index existed", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "runtime-provider-read", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.catchUp();
    const projectionPath = projection.path;
    projection.close();

    const db = new DatabaseSync(projectionPath);
    db.exec("DROP INDEX runtime_session_provider_session");
    const insert = db.prepare(
      "INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json) VALUES (?, ?, ?)",
    );
    const withProvider = (runtimeSessionId: string, outcome: string | null, providerSessionId: string) =>
      JSON.stringify({ ...session(runtimeSessionId, outcome), providerSessionId });
    for (let index = 0; index < settledCount; index += 1) {
      const runtimeSessionId = `runtime-settled-${String(index).padStart(5, "0")}`;
      insert.run(runtimeSessionId, index + 1, withProvider(runtimeSessionId, "succeeded", `native-${index}`));
    }
    insert.run("runtime-resumed-b", settledCount + 1, withProvider("runtime-resumed-b", null, "native-7"));
    db.close();

    const reopened = makeTaskProjection({ rootDir, eventStore: store, projectionPath });
    assert.deepEqual(
      reopened.readRuntimeSessions({ providerSessionId: "native-7" }).map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-resumed-b", "runtime-settled-00007"],
      "settled and unsettled sessions of the named provider session, in id order",
    );
    assert.deepEqual(reopened.readRuntimeSessions({ providerSessionId: "native-missing" }), []);
    reopened.close();

    const planDb = new DatabaseSync(projectionPath);
    planDb.exec("ANALYZE");
    const planText = planDb
      .prepare(
        [
          "EXPLAIN QUERY PLAN",
          "SELECT value_json FROM runtime_session",
          "WHERE json_extract(value_json, '$.providerSessionId') = ? ORDER BY runtime_session_id",
        ].join(" "),
      )
      .all("native-7")
      .map(({ detail }) => String(detail))
      .join("\n");
    planDb.close();
    t.diagnostic(planText);
    assert.match(planText, /SEARCH runtime_session USING INDEX runtime_session_provider_session \(<expr>=\?\)/u);
    assert.doesNotMatch(planText, /SCAN runtime_session/u, planText);
    await store.drain();
  });
});
