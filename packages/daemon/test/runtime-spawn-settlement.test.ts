// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

test("an exit-zero protocol error settles as unknown", () => {
  const result = classifyRuntimeExit(active({ protocolError: true }), 0);
  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /protocol evidence/u);
});

test("an exit-zero write-capable attempt without write or plan evidence settles as unknown", () => {
  const result = classifyRuntimeExit(active({ writeItemObserved: false, planObserved: false }), 0);
  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /write or plan evidence/u);
});

test("an exit-zero attempt with an incomplete plan settles as unknown", () => {
  assert.equal(
    classifyRuntimeExit(active({ writeItemObserved: true, planObserved: true, planIncomplete: true }), 0).outcome,
    "unknown",
  );
});

function active(overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return {
    dispatchId: "dispatch_0123456789abcdef01234567",
    instanceId: "provider-a",
    model: "model-a",
    cancelRequested: false,
    kindId: "codex",
    fallbackAttempt: null,
    permissionMode: "bypass",
    providerFault: null,
    errorOverflowed: false,
    errorBuffer: "",
    toolCallObserved: false,
    failureText: null,
    lossReason: null,
    planIncomplete: false,
    planObserved: true,
    protocolError: false,
    providerOutcome: "succeeded",
    writeItemObserved: true,
    ...overrides,
  } as ActiveRuntime;
}
