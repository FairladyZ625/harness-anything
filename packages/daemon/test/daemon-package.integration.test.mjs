// harness-test-tier: integration
import test from "node:test";

test("installed daemon package serves, owns its singleton, stops, and hosts a runtime worker", async () => {
  await import("../scripts/smoke-package.mjs");
});
