import test from "node:test";

if (process.env.HARNESS_RUNNER_STALL_FIXTURE === "post-complete-wedge") {
  process.on("exit", () => {
    process.title = "ha-node-test-wedge tools/test-fixtures/.runner-stall/post-complete-wedge.test.mjs";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
}

test("post-complete wedge fixture passes before native-style exit deadlock", () => {});
