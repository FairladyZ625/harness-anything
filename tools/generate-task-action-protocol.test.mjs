// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { generateTaskActionProtocolProjection, projectTaskActions } from "./generate-task-action-protocol.mjs";

test("Task Action transport has one current build-time projection", () => {
  assert.doesNotThrow(() => generateTaskActionProtocolProjection(true));
  assert.deepEqual(
    projectTaskActions().actions.map(({ id }) => id),
    ["create", "start", "transition", "submit", "review", "consent", "reconcile", "repoint", "complete"],
  );
});
