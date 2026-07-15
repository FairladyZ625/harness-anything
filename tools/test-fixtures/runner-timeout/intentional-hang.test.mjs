// harness-test-tier: fast
import test from "node:test";

test("runner timeout fixture becomes intentionally non-terminating", async () => {
  if (process.env.HARNESS_RUNNER_TIMEOUT_FIXTURE !== "hang") return;
  await new Promise(() => {});
});
