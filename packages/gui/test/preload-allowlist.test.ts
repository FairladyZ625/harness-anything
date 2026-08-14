// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { HARNESS_PRELOAD_API, assertPreloadPayload, getPreloadApiCapability, isAllowedPreloadApiMethod,
  localMainPreloadMethods, preloadAllowlist, shippedPreloadMethods } from "../src/index.ts";

test("preload exposes only the approved API methods", () => {
  const approved = [...[...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonGuiStreamFacets].map(({ guiBridgeMethod }) => guiBridgeMethod), ...localMainPreloadMethods];
  assert.equal(HARNESS_PRELOAD_API, "harness");
  assert.deepEqual(preloadAllowlist, approved);
  assert.deepEqual(shippedPreloadMethods, approved);
  assert.equal(isAllowedPreloadApiMethod("getTasks"), true);
  assert.equal(isAllowedPreloadApiMethod("getTaskDetail"), false);
  assert.throws(() => assertPreloadPayload("readFile", {}), /not allowed/u);
  assert.throws(() => assertPreloadPayload("getTasks", []), /object or null/u);
  assert.throws(() => assertPreloadPayload("getTasks", null), /repoId/u);
  assert.throws(() => assertPreloadPayload("getTasks", {}), /repoId/u);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "" }), /repoId/u);
  assert.equal(assertPreloadPayload("getTasks", { repoId: "repo-a" }), true);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "repo-a", staleRepoId: "repo-b" }), /not allowed/u);
  assert.throws(() => assertPreloadPayload("getSystemStatus", { repoId: "repo-a" }), /not allowed/u);
  assert.equal(getPreloadApiCapability("getTasks").status, "shipped");
  assert.equal(daemonGuiActionMethods.length, 18); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"), false); assert.equal(preloadAllowlist.includes("daemon.agentRuntime.credentials.bind" as never), false); assert.equal(preloadAllowlist.includes("startTask"), true); assert.equal(preloadAllowlist.includes("showReceipt"), true);
});
