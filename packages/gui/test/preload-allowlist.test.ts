import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  isAllowedPreloadApiMethod,
  preloadAllowlist
} from "../src/index.ts";

test("preload exposes only the approved API methods", () => {
  assert.equal(HARNESS_PRELOAD_API, "harness");
  assert.deepEqual(preloadAllowlist, [
    "getTasks",
    "getTaskDetail",
    "getTaskDocument",
    "setTaskStatus",
    "reviewTask",
    "archiveTask",
    "appendTaskProgress",
    "rebuildGovernance",
    "openShell"
  ]);
  assert.equal(isAllowedPreloadApiMethod("getTasks"), true);
  assert.equal(isAllowedPreloadApiMethod("readFile"), false);
  assert.throws(() => assertPreloadPayload("readFile", {}), /not allowed/);
  assert.throws(() => assertPreloadPayload("getTasks", []), /object or null/);
});
