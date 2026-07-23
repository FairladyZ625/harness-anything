// harness-test-tier: fast
import test from "node:test";

if (process.env.HARNESS_RUNNER_STALL_FIXTURE === "chatter") {
  for (let index = 0; index < 30; index += 1) {
    console.log(`runner chatter ${index + 1}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("runner chatter fixture stays inert unless it is explicitly enabled", () => {});
