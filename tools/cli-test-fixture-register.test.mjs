// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createCliTestFixtureRunner } from "./cli-test-fixture-register.mjs";

test("CLI fixture preload defers its composition imports until the fixture is used", async () => {
  let loads = 0;
  const runner = createCliTestFixtureRunner(async () => {
    loads += 1;
    return {
      runRegisteredCommandWithCliComposition: async (command, options) => ({
        command,
        scope: options.localCoordinatorScope,
        authorityCommandSubmission: options.inlineCreateProvenanceOnly === true
      }),
      toCommandReceipt: (result) => result
    };
  });

  assert.equal(loads, 0);
  assert.deepEqual(await runner("first"), {
    command: "first",
    scope: "test-fixture",
    authorityCommandSubmission: false
  });
  assert.deepEqual(await runner("second"), {
    command: "second",
    scope: "test-fixture",
    authorityCommandSubmission: false
  });
  const taskSubmit = { action: { kind: "task-submit" } };
  assert.deepEqual(await runner(taskSubmit), {
    command: taskSubmit,
    scope: "test-fixture",
    authorityCommandSubmission: true
  });
  assert.equal(loads, 1);
});
