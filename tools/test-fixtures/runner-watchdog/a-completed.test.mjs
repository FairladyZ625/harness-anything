// harness-test-tier: fast
import test from "node:test";

const leavesFailure = process.env.HARNESS_RUNNER_OPEN_HANDLE_FIXTURE === "1";
test("completed before a different file exceeded its deadline", () => {
  if (leavesFailure) throw new Error("runner watchdog completed-file assertion details");
});

if (leavesFailure) {
  for (let index = 0; index < 220; index += 1) {
    test(`runner watchdog output tail ${index}`, () => undefined);
  }
}
