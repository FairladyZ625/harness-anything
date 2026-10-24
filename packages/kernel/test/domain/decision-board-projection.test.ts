// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  decisionCapabilities,
  decisionCapabilityIds,
  decisionCapabilityReasons,
  decisionClaimsOpen,
  isTerminalDecisionState,
} from "../../src/domain/decision-board-projection.ts";
import { decisionStates, decisionTransitionDefinitions } from "../../src/domain/decision-event.ts";
import { explainEntityKind } from "../../src/domain/entity-kind-registry.ts";
import { statusWordRegister } from "../../src/domain/status-word-register.ts";

test("capability ids are the canonical Decision transition actions in target-state bijection", () => {
  assert.deepEqual(decisionCapabilityIds, ["accept", "reject", "defer", "supersede", "retire"]);
  assert.deepEqual(
    decisionTransitionDefinitions.map(({ action, targetState }) => [action, targetState]),
    [
      ["accept", "in_effect"],
      ["reject", "rejected"],
      ["defer", "deferred"],
      ["supersede", "superseded"],
      ["retire", "outcome_retired"],
    ],
  );
  assert.equal(new Set(decisionTransitionDefinitions.map(({ targetState }) => targetState)).size, 5);
  const actionIds = new Set(explainEntityKind("decision")!.transitions.actions.map(({ id }) => id));
  assert.deepEqual(
    decisionCapabilityIds.filter((id) => !actionIds.has(id)),
    [],
  );
  assert.equal(explainEntityKind("decision")!.transitions.available.includes("supersede"), false);
});

test("capabilities expose only row-visible lifecycle admission", () => {
  const available = Object.fromEntries(
    decisionStates.map((state) => [
      state,
      decisionCapabilities(state)
        .filter((capability) => capability.available)
        .map(({ id }) => id),
    ]),
  );
  assert.deepEqual(available, {
    proposed: ["accept", "reject", "defer"],
    in_effect: ["supersede", "retire"],
    rejected: [],
    deferred: [],
    superseded: [],
    outcome_retired: [],
  });
  for (const state of decisionStates)
    for (const capability of decisionCapabilities(state))
      assert.equal(capability.available, capability.reason === null, `${state}/${capability.id}`);
});

test("claims remain open exactly in the admission states and reasons are non-status codes", () => {
  assert.deepEqual(
    decisionStates.map((state) => [state, decisionClaimsOpen(state)]),
    [
      ["proposed", true],
      ["in_effect", true],
      ["rejected", false],
      ["deferred", false],
      ["superseded", false],
      ["outcome_retired", false],
    ],
  );
  const registered = new Set(statusWordRegister.map(({ word }) => word));
  assert.deepEqual(
    decisionCapabilityReasons.filter((reason) => registered.has(reason)),
    [],
  );
});

test("a decision is follow-up terminal in every state except proposed", () => {
  // proposed 是唯一仍待裁决的状态;其余状态(含 deferred——它没有任何出边转换)
  // 都不会再产生「跟进提示所等待的下一次写入」。
  assert.deepEqual(
    decisionStates.filter((state) => isTerminalDecisionState(state)),
    ["in_effect", "rejected", "deferred", "superseded", "outcome_retired"],
  );
  assert.equal(isTerminalDecisionState("proposed"), false);
  assert.equal(isTerminalDecisionState("deferred"), true, "deferred has no outgoing transition and must be terminal");
});
