// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  isGenericStatusWriteSource,
  isGenericStatusWriteTarget,
  isGenericStatusWriteTransition
} from "../src/renderer/model/types.ts";

test("generic GUI lifecycle controls keep Execution-owned and terminal states read-only", () => {
  assert.deepEqual(["active", "blocked"].filter(isGenericStatusWriteTarget), ["active", "blocked"]);
  assert.equal(["planned", "in_review", "done", "cancelled", "unknown"].some(isGenericStatusWriteTarget), false);
  assert.deepEqual(["planned", "active", "blocked"].filter(isGenericStatusWriteSource), ["planned", "active", "blocked"]);
  assert.equal(["in_review", "done", "cancelled", "unknown"].some(isGenericStatusWriteSource), false);
  assert.equal(isGenericStatusWriteTransition("planned", "active"), true);
  assert.equal(isGenericStatusWriteTransition("active", "blocked"), true);
  assert.equal(isGenericStatusWriteTransition("blocked", "active"), true);
  assert.equal(isGenericStatusWriteTransition("in_review", "active"), false);
  assert.equal(isGenericStatusWriteTransition("in_review", "blocked"), false);
  assert.equal(isGenericStatusWriteTransition("done", "active"), false);
});
