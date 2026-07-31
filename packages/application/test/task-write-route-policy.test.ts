// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { taskStatusLeaseRequired } from "../src/task-write-route-policy.ts";

test("task status lease policy exempts only the planned return direction", () => {
  assert.equal(taskStatusLeaseRequired("planned"), false);
  assert.equal(taskStatusLeaseRequired("active"), true);
  assert.equal(taskStatusLeaseRequired("blocked"), true);
  assert.equal(taskStatusLeaseRequired("in_review"), true);
  assert.equal(taskStatusLeaseRequired(undefined), true);
});
