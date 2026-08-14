// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { HARNESS_PRELOAD_API, assertPreloadPayload, getPreloadApiCapability, isAllowedPreloadApiMethod,
  preloadAllowlist, shippedPreloadMethods } from "../src/index.ts";

test("preload exposes only the approved API methods", () => {
  const contracted = [...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets].map(({ guiBridgeMethod }) => guiBridgeMethod);
  assert.equal(HARNESS_PRELOAD_API, "harness");
  assert.deepEqual(preloadAllowlist, contracted);
  assert.deepEqual(shippedPreloadMethods, contracted);
  assert.equal(isAllowedPreloadApiMethod("getTasks"), true);
  assert.equal(isAllowedPreloadApiMethod("getTaskDetail"), false);
  assert.throws(() => assertPreloadPayload("readFile", {}), /not allowed/u);
  assert.throws(() => assertPreloadPayload("getTasks", []), /object or null/u);
  assert.equal(getPreloadApiCapability("getTasks").status, "shipped");
  assert.equal(daemonGuiActionMethods.length, 10); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"), false); assert.equal(preloadAllowlist.includes("startTask"), true); assert.equal(preloadAllowlist.includes("showReceipt"), true);
});
