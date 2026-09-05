// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { runScaleCalibration } from "./scale-runner.mjs";

test("S4 calibrates 10k commands, 1k blobs, rebuilds, and kill/restart", { timeout: 900_000 }, async () => {
  const result = await runScaleCalibration();
  assert.equal(result.sample.commands, 10_000);
  assert.equal(result.sample.acceptedEvents, 10_000);
  assert.equal(result.sample.blobs, 1_000);
  assert.equal(result.sample.clients, 8);
});
