// harness-test-tier: fast
// harness-test-file-timeout: none
import test from "node:test";

// Exercised by tools/run-node-tests.test.mjs: outside CI the unbounded marker lets this file outlive a tiny
// default timeout; under CI=1 the runner keeps the default watchdog and kills it.
test("runner unbounded fixture", async () => {
  if (process.env.HARNESS_RUNNER_UNBOUNDED_FIXTURE !== "1") return;
  await new Promise((resolve) => setTimeout(resolve, 600));
});
