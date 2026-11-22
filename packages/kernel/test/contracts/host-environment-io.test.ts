// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  hostEnvironmentFiles,
  hostEnvironmentIoModule,
  hostEnvironmentIoPorts,
} from "../../src/domain/host-environment-io.ts";

test("model pricing cache is a fixed host file owned by its daemon writer", () => {
  assert.deepEqual(hostEnvironmentFiles.modelPricingCache, {
    name: "model-pricing-cache.json",
    owner: "packages/daemon/src/daemon-host/model-pricing-refresh.ts",
  });
  assert.ok(
    hostEnvironmentIoPorts.some(
      ({ module, scope, effects }) =>
        module === hostEnvironmentIoModule &&
        scope === "writeHostEnvironmentFile" &&
        ["open", "writeFile", "rename", "rm"].every((effect) => effects.includes(effect)),
    ),
  );
});
