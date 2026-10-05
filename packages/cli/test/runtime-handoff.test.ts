// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("handoff CLI routes explicit export, claim and revoke through the shared RPC", () => {
  const dispatchId = `dispatch_${"a".repeat(24)}`;
  for (const operation of ["export", "claim", "revoke"]) {
    const parsed = parseThinCommand([
      "runtime",
      "handoff",
      operation,
      dispatchId,
      ...(operation === "claim" ? ["--instance", "target-codex", "--prompt", "Continue"] : []),
    ]);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    assert.equal(parsed.command.method, "repo.agentRuntime.handoff");
    assert.equal(parsed.command.action.operation, operation);
    assert.equal(parsed.command.action.dispatchId, dispatchId);
  }
  assert.equal(parseThinCommand(["runtime", "handoff", "claim", dispatchId]).ok, false);
});
test("new task-bound agent sessions explicitly opt into handoff", () => {
  const parsed = parseThinCommand(["agent", "run", "astra", "--task", "task-one", "--enable-handoff"]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error(parsed.nextAction);
  assert.equal(parsed.command.action.handoffEnabled, true);
});
