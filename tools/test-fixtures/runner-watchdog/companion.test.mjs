// harness-test-tier: fast
// harness-test-file-timeout: 10000
import test from "node:test";

test("companion is cancelled when the shared process tree times out", () => {
  if (process.env.HARNESS_RUNNER_OPEN_HANDLE_FIXTURE === "1") setInterval(() => undefined, 1_000);
});
