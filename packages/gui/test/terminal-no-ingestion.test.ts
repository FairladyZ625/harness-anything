// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { shellPanelPolicy } from "../src/index.ts";

// harness-contract: gui.terminal-display-only
test("PTY output stays display-only and cannot create task state", () => {
  assert.equal(shellPanelPolicy.spawnRequiresUserAction, true);
  assert.equal(shellPanelPolicy.hiddenCommandInjectionAllowed, false);
  assert.equal(shellPanelPolicy.outputCreatesTaskState, false);
  assert.equal(shellPanelPolicy.outputCreatesEvidence, false);
});
