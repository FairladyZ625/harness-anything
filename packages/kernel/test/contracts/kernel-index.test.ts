// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import * as kernel from "../../src/index.ts";
import * as runtimeEffortModule from "@harness-anything/kernel/runtime-effort";
import { TASK_LIFECYCLE_COMMAND_CATALOG } from "../../src/domain/task-lifecycle.contract.ts";

test("kernel public source index is importable by the explicit TS test runner", () => {
  assert.equal(kernel.REPLAY_TASK_GRAPH.template, "replay/v1");
  assert.deepEqual(
    TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => entry.commandType),
    [
      "CreateReplayTask",
      "StartExecution",
      "TransitionTask",
      "SubmitExecution",
      "AdjudicateSubmission",
      "RecordReview",
      "RecordReviewConsent",
      "CompleteTask",
    ],
  );
  assert.deepEqual(
    [...kernel.decisionStates],
    ["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
  );
  assert.deepEqual(kernel.runtimeEffortValues, ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(runtimeEffortModule.runtimeEffortValues, kernel.runtimeEffortValues);
  assert.equal("LifecycleEngine" in kernel, false);
  assert.equal("LockRegistry" in kernel, false);
  assert.equal("VersionControlSystem" in kernel, false);
  assert.equal(typeof kernel.makeTaskEventStore, "function");
  assert.equal(typeof kernel.makeTaskProjection, "function");
  assert.equal(typeof kernel.schemaRegistry.length, "number");
});
