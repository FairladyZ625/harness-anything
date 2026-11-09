// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { forwardingIntentForAction, forwardingIntentIssue } from "../src/fleet/forwarding-intent.ts";

test("forwarding intent binds command identity, method and execution context", () => {
  const action = { kind: "fact-record", executionId: "execution-one", statement: "evidence" },
    intent = forwardingIntentForAction("repo.task.run", action);
  assert.equal(intent.commandId, "fact-record");
  assert.deepEqual(intent.executionContext, { executionId: "execution-one" });
  assert.equal(forwardingIntentIssue(intent), null);
});

test("forwarding intent rejects mismatched identity, method, execution and route declarations", () => {
  const action = { kind: "fact-record", executionId: "execution-one" },
    intent = forwardingIntentForAction("repo.task.run", action);
  assert.match(forwardingIntentIssue({ ...intent, commandId: "decision-propose" }) ?? "", /commandId/u);
  assert.match(forwardingIntentIssue({ ...intent, method: "repo.task.read" }) ?? "", /method/u);
  assert.match(
    forwardingIntentIssue({ ...intent, executionContext: { executionId: "execution-two" } }) ?? "",
    /execution context/u,
  );
  assert.match(
    forwardingIntentIssue(forwardingIntentForAction("repo.task.read", { kind: "task-show" })) ?? "",
    /not center-forwardable/u,
  );
});
