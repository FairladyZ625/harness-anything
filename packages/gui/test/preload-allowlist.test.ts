// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_PRELOAD_API,
  assertPreloadPayload,
  deferredPreloadMethods,
  getPreloadApiCapability,
  isAllowedPreloadApiMethod,
  preloadAllowlist,
  shippedPreloadMethods
} from "../src/index.ts";

test("preload exposes only the approved API methods", () => {
  assert.equal(HARNESS_PRELOAD_API, "harness");
  assert.deepEqual(preloadAllowlist, [
    "getTasks",
    "getTaskDetail",
    "getTaskDocument",
    "setTaskStatus",
    "reviewTask",
    "appendTaskProgress",
    "rebuildGovernance",
    "getTriadicProjection",
    "getRelationGraph",
    "getDecisions",
    "getDecisionDetail",
    "getFacts",
    "getTaskFacts",
    "getExecutions",
    "getTaskExecutions",
    "getExecutionDetail",
    "getReviewDetail",
    "archiveTask",
    "openShell"
  ]);
  assert.equal(isAllowedPreloadApiMethod("getTasks"), true);
  assert.equal(isAllowedPreloadApiMethod("readFile"), false);
  assert.throws(() => assertPreloadPayload("readFile", {}), /not allowed/);
  assert.throws(() => assertPreloadPayload("getTasks", []), /object or null/);
});

test("preload capabilities distinguish shipped methods from deferred placeholders", () => {
  assert.deepEqual(shippedPreloadMethods, [
    "getTasks",
    "getTaskDetail",
    "getTaskDocument",
    "setTaskStatus",
    "reviewTask",
    "appendTaskProgress",
    "rebuildGovernance",
    "getTriadicProjection",
    "getRelationGraph",
    "getDecisions",
    "getDecisionDetail",
    "getFacts",
    "getTaskFacts",
    "getExecutions",
    "getTaskExecutions",
    "getExecutionDetail",
    "getReviewDetail"
  ]);
  assert.deepEqual(deferredPreloadMethods, ["archiveTask", "openShell"]);
  assert.equal(getPreloadApiCapability("getTasks").status, "shipped");
  assert.equal(getPreloadApiCapability("archiveTask").status, "deferred");
  assert.match(getPreloadApiCapability("archiveTask").reason ?? "", /placeholder/);
  assert.equal(getPreloadApiCapability("openShell").status, "deferred");
  assert.match(getPreloadApiCapability("openShell").reason ?? "", /display-only/);
});
