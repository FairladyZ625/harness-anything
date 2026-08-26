// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { deriveRuntimeSpawnOutcome } from "../src/runtime-spawn-settlement.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

test("an exit-zero protocol error settles as unknown", () => {
  assert.equal(deriveRuntimeSpawnOutcome(active({ protocolError: true }), 0), "unknown");
});

test("an exit-zero write-capable attempt without write or plan evidence settles as unknown", () => {
  assert.equal(deriveRuntimeSpawnOutcome(active({ writeItemObserved: false, planObserved: false }), 0), "unknown");
});

test("an exit-zero attempt with an incomplete plan settles as unknown", () => {
  assert.equal(
    deriveRuntimeSpawnOutcome(active({ writeItemObserved: true, planObserved: true, planIncomplete: true }), 0),
    "unknown",
  );
});

function active(overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return {
    cancelRequested: false,
    kindId: "codex",
    permissionMode: "bypass",
    planIncomplete: false,
    planObserved: true,
    protocolError: false,
    providerOutcome: "succeeded",
    writeItemObserved: true,
    ...overrides,
  } as ActiveRuntime;
}
