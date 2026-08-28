// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/index.ts";

const ingressKinds = [
  "decision-accept",
  "decision-amend",
  "decision-claim-add",
  "decision-claim-fulfill",
  "decision-defer",
  "decision-list",
  "decision-propose",
  "decision-reckon",
  "decision-reject",
  "decision-relate",
  "decision-relation-replace",
  "decision-relation-retire",
  "decision-repin",
  "decision-retire",
  "decision-show",
  "decision-supersede",
  "decision-transition",
  "decision-validate",
  "fact-record",
  "fact-search",
  "fact-show",
] as const;

test("Decision and Fact ingress resolves to executable per-action catalog declarations", () => {
  for (const ingress of ingressKinds) {
    const action = getExecutableEntityAction(ingress);
    assert.ok(action?.execution, ingress);
    assert.equal(action.execution.ingress, ingress);
    assert.equal(action.execution.receipt.visibility, "center");
    assert.equal(action.execution.rejections.invalidInput, "invalid_command");
    assert.equal(
      action.execution.compile === null,
      ["decision-list", "decision-show", "decision-validate", "fact-search", "fact-show"].includes(ingress),
      ingress,
    );
  }
  assert.equal(getExecutableEntityAction("fact-undeclared"), undefined);
});

test("entity explanations expose action identity but keep runtime compile hooks private", () => {
  for (const kind of ["decision", "fact"] as const) {
    const explanation = explainEntityKind(kind);
    assert.ok(explanation.transitions.actions.length > 0);
    for (const action of explanation.transitions.actions) assert.equal(Object.hasOwn(action, "execution"), false);
  }
});
