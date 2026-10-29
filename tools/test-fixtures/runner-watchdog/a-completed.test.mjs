// harness-test-tier: fast
import test from "node:test";

test("completed before a different file exceeded its deadline", () => {
  if (process.env.HARNESS_RUNNER_OPEN_HANDLE_FIXTURE === "1") {
    throw new Error("runner watchdog completed-file assertion details");
  }
});
