// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_LIFECYCLE_COMMAND_CATALOG,
  TaskLifecycleContractError
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { addWriteTarget, freezeWritePlan, validateWritePlan } from "../../../packages/kernel/src/domain/task-write-decision.ts";

const targets = [
  { kind: "event_file", path: "harness/events/op-1.json", operation: "create" },
  { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
  { kind: "projection_invalidation", projection: "task-lifecycle/v1", key: "task-1" },
  { kind: "content_blob", sha256: "a".repeat(64), size: 4, mediaType: "text/plain" }
];

test("G28 freezes a unique declared write set and rejects late targets", () => {
  const frozen = freezeWritePlan({ commandType: "SubmitExecution", targets });
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.targets), true);
  assert.throws(
    () => addWriteTarget(frozen, { kind: "content_blob", sha256: "b".repeat(64), size: 4, mediaType: "text/plain" }),
    (error) => error instanceof TaskLifecycleContractError && error.code === "frozen_write_plan"
  );
});

test("G28 validates a predeclared write plan for every lifecycle command", () => {
  const commandTypes = [...new Set(TASK_LIFECYCLE_COMMAND_CATALOG.map((entry) => entry.commandType))];
  assert.deepEqual(commandTypes.sort(), ["CompleteTask", "CreateReplayTask", "RecordReview", "StartExecution", "SubmitExecution"]);
  for (const commandType of commandTypes) {
    assert.deepEqual(validateWritePlan({ commandType, targets: targets.slice(0, 3) }), []);
  }
});

test("G28 rejects duplicate targets, missing projections, and malformed content blobs", () => {
  assert.throws(() => freezeWritePlan({ commandType: "SubmitExecution", targets: [targets[0], targets[0], targets[1], targets[2]] }));
  assert.throws(() => freezeWritePlan({ commandType: "SubmitExecution", targets: [targets[0], targets[1]] }));
  assert.throws(() => freezeWritePlan({
    commandType: "SubmitExecution",
    targets: [targets[0], targets[1], targets[2], { kind: "content_blob", sha256: "short", size: 4, mediaType: "text/plain" }]
  }));
});
