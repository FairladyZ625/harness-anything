// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  generateTaskActionProtocolProjection,
  projectTaskActions,
  renderTaskActionProtocolProjection,
} from "./generate-task-action-protocol.mjs";

test("Task Action transport has one current build-time projection", async () => {
  await assert.doesNotReject(() => generateTaskActionProtocolProjection(true));
  assert.deepEqual(
    projectTaskActions().actions.map(({ id }) => id),
    ["create", "start", "transition", "submit", "review", "consent", "reconcile", "repoint", "complete"],
  );
});

test("Task Action transport projection is readable source without a compressed payload", async () => {
  const rendered = await renderTaskActionProtocolProjection();
  assert.match(rendered, /const taskActionDescriptorProjection = \{\n/u);
  assert.doesNotMatch(rendered, /brotli|base64/iu);
  assert.equal(
    rendered
      .split("\n")
      .filter((line) => line.length > 120)
      .join("\n"),
    "",
  );
});
