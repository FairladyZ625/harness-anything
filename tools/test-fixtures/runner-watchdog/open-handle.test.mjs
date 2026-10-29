// harness-test-tier: fast
import test from "node:test";

test("runner watchdog fixture leaves an open handle only when explicitly enabled", () => {
  if (process.env.HARNESS_RUNNER_OPEN_HANDLE_FIXTURE === "1") {
    setInterval(() => undefined, 1_000);
  }
});
