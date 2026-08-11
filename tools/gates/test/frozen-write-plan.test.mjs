// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_LIFECYCLE_COMMAND_CATALOG,
  TaskLifecycleContractError
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { addWriteTarget, freezeWritePlan, validateWritePlan } from "../../../packages/kernel/src/domain/task-write-decision.ts";

const targets = [
  { kind: "event_stream", stream: "harness/task-events.ndjson", operation: "append" },
  { kind: "projection_invalidation", projection: "task-lifecycle/v1", taskId: "task-1" },
  { kind: "task_artifact", path: "harness/tasks/task-1/submission.json", operation: "create" }
];

test("G28 freezes a unique declared write set and rejects late targets", () => {
  const frozen = freezeWritePlan({ commandType: "SubmitExecution", targets });
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.targets), true);
  assert.throws(
    () => addWriteTarget(frozen, { kind: "task_artifact", path: "late.json", operation: "create" }),
    (error) => error instanceof TaskLifecycleContractError && error.code === "frozen_write_plan"
  );
});

test("G28 validates a predeclared write plan for every lifecycle command", () => {
  const commandTypes = [...new Set(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => entry.commandType))];
  assert.deepEqual(commandTypes.sort(), ["CompleteTask", "CreateReplayTask", "RecordReview", "StartExecution", "SubmitExecution"]);
  for (const commandType of commandTypes) {
    assert.deepEqual(validateWritePlan({ commandType, targets: targets.slice(0, 2) }), []);
  }
});

test("G28 rejects duplicate targets, missing projections, and artifacts without a write op", () => {
  assert.throws(() => freezeWritePlan({ commandType: "SubmitExecution", targets: [targets[0], targets[0], targets[1]] }));
  assert.throws(() => freezeWritePlan({ commandType: "SubmitExecution", targets: [targets[0]] }));
  assert.throws(() => freezeWritePlan({
    commandType: "SubmitExecution",
    targets: [targets[0], targets[1], { kind: "task_artifact", path: "submission.json" }]
  }));
});
