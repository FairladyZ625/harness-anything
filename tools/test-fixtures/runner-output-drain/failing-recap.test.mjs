// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

test("runner output drain fixture emits a failing recap when explicitly enabled", () => {
  if (process.env.HARNESS_RUNNER_OUTPUT_DRAIN_FIXTURE !== "1") return;
  // Fill the forwarded stream far past the OS pipe capacity (64 KiB on Linux CI runners) so the
  // runner's final writes — the failing-tests recap carrying the assertion details — can only be
  // sitting queued in userspace at exit time, exactly like a CI lane whose log consumer lags.
  for (let index = 0; index < 600; index += 1) {
    console.log(`${"x".repeat(498)}${index}`);
  }
  assert.equal(1, 2, "runner output drain fixture assertion");
});
