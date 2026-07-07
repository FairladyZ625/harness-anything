import assert from "node:assert/strict";
import test from "node:test";
import * as kernel from "../../src/index.ts";

test("kernel public source index is importable by the explicit TS test runner", () => {
  assert.deepEqual([...kernel.domainStatuses], [
    "planned",
    "active",
    "blocked",
    "in_review",
    "done",
    "cancelled"
  ]);
  assert.deepEqual([...kernel.decisionStates], [
    "proposed",
    "active",
    "rejected",
    "deferred",
    "retired"
  ]);
  assert.equal(typeof kernel.LifecycleEngine, "object");
  assert.equal(typeof kernel.LockRegistry, "object");
  assert.equal(typeof kernel.VersionControlSystem, "object");
  assert.equal(typeof kernel.schemaRegistry.length, "number");
});
