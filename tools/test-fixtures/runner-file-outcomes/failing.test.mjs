// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

test("runner file outcome fixture fails only when explicitly enabled", () => {
  if (process.env.HARNESS_RUNNER_FILE_OUTCOMES_FIXTURE !== "1") return;
  assert.equal(1, 2, "runner file outcome fixture assertion");
});
