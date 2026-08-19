// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonGuiActionMethods, daemonGuiReadMethods, daemonGuiStreamFacets } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { HARNESS_PRELOAD_API, assertPreloadPayload, getPreloadApiCapability, isAllowedPreloadApiMethod,
  localMainPreloadMethods, preloadAllowlist, shippedPreloadMethods } from "../src/index.ts";
import { deriveEmptyRepoMethods, deriveRepoScopedMethods } from "../src/preload/allowlist.ts";

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
  assert.equal(assertPreloadPayload("updateRuntimeInstance", { instanceId: "codex-review", enabled: false }), true);
  assert.throws(() => assertPreloadPayload("updateRuntimeInstance", { instanceId: "codex-review", enabled: false, authMode: "api-key" }), /invalid/u);
  assert.throws(() => assertPreloadPayload("getTasks", { repoId: "repo-a", staleRepoId: "repo-b" }), /not allowed/u);
  assert.throws(() => assertPreloadPayload("getSystemStatus", { repoId: "repo-a" }), /not allowed/u);
  assert.equal(getPreloadApiCapability("getTasks").status, "shipped");
  assert.equal(daemonGuiActionMethods.length, 19); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.task.run"), false); assert.equal(daemonGuiActionMethods.some(({ method }) => method === "repo.agentRuntime.cancel"), true); assert.equal(preloadAllowlist.includes("daemon.agentRuntime.credentials.bind" as never), false); assert.equal(preloadAllowlist.includes("startTask"), true); assert.equal(preloadAllowlist.includes("showReceipt"), true);
});

test("repo and empty scopes are derived when a GUI contract grows", () => {
  const facets = [{ guiBridgeMethod: "futureRepoRead", requiresRepo: true, inputSchemaId: "gui.empty/v1" }, { guiBridgeMethod: "futureRepoReadWithInput", requiresRepo: true, inputSchemaId: "gui.future/v1" }];
  assert.equal(deriveRepoScopedMethods(facets).has("futureRepoRead"), true);
  assert.equal(deriveRepoScopedMethods(facets).has("futureRepoReadWithInput"), true);
  assert.equal(deriveEmptyRepoMethods(facets).has("futureRepoRead"), true);
  assert.equal(deriveEmptyRepoMethods(facets).has("futureRepoReadWithInput"), false);
});
