// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { selectStopPoint } from "./run-stop-point.mjs";

test("canonical stop point selects local gates without CI context", () => {
  assert.deepEqual(selectStopPoint({}), { mode: "local", script: "tools/run-local-check.mjs" });
});

test("canonical stop point upgrades both common CI markers to CI-equivalent gates", () => {
  assert.deepEqual(selectStopPoint({ CI: "true" }), { mode: "CI", script: "tools/run-ci-equivalent.mjs" });
  assert.deepEqual(selectStopPoint({ CI: "1" }), { mode: "CI", script: "tools/run-ci-equivalent.mjs" });
});
