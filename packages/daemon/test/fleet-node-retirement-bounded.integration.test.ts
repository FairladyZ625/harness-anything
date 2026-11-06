// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { createNodeRetirement } from "../src/fleet/node-retirement.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";

const settledCount = 2_000;
const foreignUnsettledCount = 300;

function session(runtimeSessionId: string, liveness: "live" | "exited", outcome: string | null): string {
  return JSON.stringify({
    runtimeSessionId,
    instanceId: "deepseek-worker",
    installationId: "installation-deepseek",
    kindId: "deepseek-harness",
    definitionSnapshotRef: "artifact:runtime-definitions/deepseek/v1",
    providerSessionId: null,
    transcriptRef: null,
    launchGeneration: 1,
    liveness,
    attachable: liveness === "live",
    taskBindings: [],
    outcome,
    exitCode: outcome === null ? null : 0,
    resultRef: null,
    lastObservedAt: "2026-11-01T00:00:00.000Z",
  });
}

test("node retirement reports only that node's live executions in a large session history", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "node-retirement-bounded", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.catchUp();
    const projectionPath = projection.path;
    projection.close();

    // Deployed-shape history: 2,000 settled sessions owned by the retiring node, 300 unsettled
    // sessions owned by another node, and only two live sessions the retirement actually needs.
    const db = new DatabaseSync(projectionPath);
    const insert = db.prepare(
      "INSERT INTO runtime_session(runtime_session_id, workspace_revision, value_json, execution_node_id) " +
        "VALUES (?, ?, ?, ?)",
    );
    let revision = store.read().revision + 1;
    for (let index = 0; index < settledCount; index += 1) {
      const runtimeSessionId = `runtime-settled-${String(index).padStart(5, "0")}`;
      insert.run(runtimeSessionId, revision++, session(runtimeSessionId, "exited", "succeeded"), "node-a");
    }
    for (let index = 0; index < foreignUnsettledCount; index += 1) {
      const runtimeSessionId = `runtime-foreign-${String(index).padStart(5, "0")}`;
      insert.run(runtimeSessionId, revision++, session(runtimeSessionId, "live", null), "node-b");
    }
    for (const runtimeSessionId of ["runtime-open-node-a-1", "runtime-open-node-a-2"])
      insert.run(runtimeSessionId, revision++, session(runtimeSessionId, "live", null), "node-a");
    // An exit recorded before its outcome event is not in-flight work, exactly as before the fix.
    insert.run("runtime-exited-open-node-a", revision, session("runtime-exited-open-node-a", "exited", null), "node-a");
    db.close();

    const retirement = createNodeRetirement({
        stateRoot: rootDir,
        repositories: () => [{ repoId: "node-retirement-bounded", rootDir, state: "attached" }],
      }),
      snapshot = retirement.inspect("node-a");

    assert.deepEqual(
      snapshot.executions.map(({ runtimeSessionId }) => runtimeSessionId),
      ["runtime-open-node-a-1", "runtime-open-node-a-2"],
      "the report is sized by node-a's unsettled sessions, not its 2,000 settled sessions or node-b's 300",
    );
    assert.deepEqual(snapshot.leases, []);
    await store.drain();
  });
});
