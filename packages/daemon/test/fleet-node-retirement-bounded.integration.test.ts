// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { projectDispatchLifecycleEvent } from "../../storage/src/projection/dispatch-lifecycle-projection.ts";
import { lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";
import { createNodeRetirement } from "../src/fleet/node-retirement.ts";
import { withTempStoreAsync } from "../../storage/test/store/helpers.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";

const settledCount = 2_000;
const foreignUnsettledCount = 300;

test("node retirement reports only that node's held lifecycle reservations in a large history", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "node-retirement-bounded", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.catchUp();
    const projectionPath = projection.path;
    projection.close();

    // Fold the canonical reducer into the real projection: 2,000 closed groups, 300 foreign
    // active groups, two held slots for this node, and one stop-proven slot awaiting outcome.
    const db = new DatabaseSync(projectionPath);
    const add = (runtimeSessionId: string, nodeId: string, terminal?: "X" | "O") => {
      const options = { source: { kind: "node" as const, nodeId }, instanceId: "deepseek-worker" };
      projectDispatchLifecycleEvent(db, lifecycleEvent("R", runtimeSessionId, options));
      projectDispatchLifecycleEvent(db, lifecycleEvent("S", runtimeSessionId, options));
      if (terminal) projectDispatchLifecycleEvent(db, lifecycleEvent(terminal, runtimeSessionId, options));
    };
    db.exec("BEGIN");
    for (let index = 0; index < settledCount; index += 1)
      add(`runtime-settled-${String(index).padStart(5, "0")}`, "node-a", "O");
    for (let index = 0; index < foreignUnsettledCount; index += 1)
      add(`runtime-foreign-${String(index).padStart(5, "0")}`, "node-b");
    for (const runtimeSessionId of ["runtime-open-node-a-1", "runtime-open-node-a-2"]) add(runtimeSessionId, "node-a");
    add("runtime-exited-open-node-a", "node-a", "X");
    db.exec("COMMIT");
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
