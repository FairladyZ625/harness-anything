// harness-test-tier: fast
import test from "node:test";

// Blocks the main thread before any test is registered — the shape
// `--test-timeout` cannot rescue, because with no test running there is nothing
// for it to time out. `Atomics.wait` reproduces the futex wedge seen in CI
// without burning a core. Only the stall escalation in
// tools/run-node-tests.mjs can end this run.
if (process.env.HARNESS_RUNNER_STALL_FIXTURE === "wedge") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

test("runner stall fixture stays inert unless it is explicitly enabled", () => {});
