// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { classifyRuntimeExit } from "../src/runtime-provider-fault.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

test("exit zero is success evidence even when provider protocol evidence is incomplete", () => {
  const result = classifyRuntimeExit(active({ protocolError: true }), 0);
  assert.equal(result.outcome, "succeeded");
  assert.match(result.reason, /successfully/u);
});

test("exit zero does not require a separate write or plan declaration", () => {
  const result = classifyRuntimeExit(active({ writeItemObserved: false, planObserved: false }), 0);
  assert.equal(result.outcome, "succeeded");
});

test("exit zero does not turn an internal plan heuristic into an unknown outcome", () => {
  assert.equal(
    classifyRuntimeExit(active({ writeItemObserved: true, planObserved: true, planIncomplete: true }), 0).outcome,
    "succeeded",
  );
});

test("a write-capable squad leader converged decision settles as succeeded without per-turn write evidence", () => {
  const result = classifyRuntimeExit(
    active({
      squadId: "core-squad",
      delegatedBy: null,
      finalText: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Synthesis" }),
      writeItemObserved: false,
      planObserved: false,
    }),
    0,
  );
  assert.equal(result.outcome, "succeeded");
});

test("a non-zero squad leader exit is failed even when its final text declares convergence", () => {
  const result = classifyRuntimeExit(
    active({
      squadId: "core-squad",
      delegatedBy: null,
      finalText: JSON.stringify({ schema: "squad-decision/v1", action: "converged", report: "# Synthesis" }),
      writeItemObserved: false,
      planObserved: false,
    }),
    1,
  );
  assert.equal(result.outcome, "failed");
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
