import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellOutput, shellPanelPolicy } from "../src/index.ts";

test("PTY output stays display-only and cannot create task state", () => {
  assert.equal(shellPanelPolicy.spawnRequiresUserAction, true);
  assert.equal(shellPanelPolicy.hiddenCommandInjectionAllowed, false);
  assert.equal(shellPanelPolicy.outputCreatesTaskState, false);
  assert.equal(shellPanelPolicy.outputCreatesEvidence, false);
  assert.deepEqual(classifyShellOutput("status: done"), {
    displayOnly: true,
    stateChange: false
  });
});
