// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { buildWrappedInvocation, parseResourceWrapperArgs } from "./run-with-local-resources.mjs";

test("resource wrapper requires an explicit command boundary", () => {
  assert.deepEqual(parseResourceWrapperArgs(["--label", "git-hook-build", "--", "npm", "run", "build"]), {
    label: "git-hook-build",
    command: "npm",
    args: ["run", "build"]
  });
  assert.throws(() => parseResourceWrapperArgs(["npm", "run", "build"]), /expected --/u);
});

test("resource wrapper places QoS before the wrapped command", () => {
  assert.deepEqual(buildWrappedInvocation(["taskpolicy", "-c", "utility"], "npm", ["run", "build"]), {
    command: "taskpolicy",
    args: ["-c", "utility", "npm", "run", "build"]
  });
});
