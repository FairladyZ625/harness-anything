// harness-test-tier: fast
import assert from "node:assert/strict";
import { after, test } from "node:test";

if (process.env.HARNESS_RUNNER_STALL_FIXTURE === "failing-wedge") {
  after(() => {
    process.title = "ha-node-test-wedge tools/test-fixtures/runner-stall/failing-then-wedge.test.mjs";
    const signal = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(signal, 0, 0);
  });
}

test("runner failing-wedge probe exposes a real failure before shutdown", () => {
  if (["failing-only", "failing-wedge"].includes(process.env.HARNESS_RUNNER_STALL_FIXTURE)) {
    assert.fail("intentional real failure before shutdown wedge");
  }
});
