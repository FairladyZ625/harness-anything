import assert from "node:assert/strict";
import test from "node:test";

if (process.env.HARNESS_FILE_WORKER_FIXTURE === "failure-post-complete-wedge") {
  process.on("exit", () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}

test("production runner preserves the real failure before an exit wedge", () => {
  if (process.env.HARNESS_FILE_WORKER_FIXTURE === "failure-post-complete-wedge") {
    assert.fail("intentional production failure before exit wedge");
  }
});
