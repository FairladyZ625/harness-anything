// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import * as kernel from "../../src/index.ts";

test("kernel public source index is importable by the explicit TS test runner", () => {
  assert.equal(kernel.REPLAY_TASK_GRAPH.template, "replay/v1");
  assert.deepEqual(kernel.TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => entry.commandType), [
    "CreateReplayTask",
    "StartExecution",
    "SubmitExecution",
    "RecordReview",
    "RecordReviewConsent",
    "ReconcileCodeDoc",
    "CompleteTask"
  ]);
  assert.deepEqual([...kernel.decisionStates], [
    "proposed",
    "active",
    "rejected",
    "deferred",
    "retired"
  ]);
  assert.equal("LifecycleEngine" in kernel, false);
  assert.equal("LockRegistry" in kernel, false);
  assert.equal(typeof kernel.VersionControlSystem, "object");
  assert.equal(typeof kernel.makeTaskEventStore, "function");
  assert.equal(typeof kernel.makeTaskProjection, "function");
  assert.equal(typeof kernel.WRITE_RECEIPT_SCHEMA, "object");
  assert.equal(typeof kernel.schemaRegistry.length, "number");
});
