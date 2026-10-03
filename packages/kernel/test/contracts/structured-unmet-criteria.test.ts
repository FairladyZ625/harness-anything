// harness-test-tier: contract
import { rejectedAcceptance } from "./receipt-acceptance.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { type AuthorizationDecision } from "../../src/index.ts";
import { validateWriteReceipt, type WriteReceipt } from "../../src/domain/receipt-domain-registry.ts";

const actor = { principal: { personId: "person-criteria" }, executor: null } as const;
const authorizationDecision: AuthorizationDecision = {
  policyRef: "keycloak-policy@1",
  actor,
  subject: "task/task-criteria",
  outcome: "allowed",
  bindingsUsed: [{ authority: "keycloak", scope: "task-start" }],
  reasonCodes: ["keycloak_allowed"],
  nextActions: [],
  evaluatedAtCut: "canonical:7",
};

const criterion = {
  ref: "task-lifecycle-command-transitions/canStartExecution",
  failureCode: "invalid_transition",
  explain: "The requested execution is admissible at the current Task cut.",
} as const;

function receipt(unmetCriteria: unknown): WriteReceipt {
  return {
    ...rejectedAcceptance,
    outcome: "op_rejected",
    opId: "op-criteria",
    code: criterion.failureCode,
    origin: "daemon",
    evidence: `criterion:${criterion.ref}`,
    nextAction: "Retry after the Task becomes startable.",
    authorizationDecision,
    unmetCriteria,
  } as WriteReceipt;
}

test("WriteReceipt accepts the closed structured unmet-criterion value", () => {
  const value = receipt([criterion]);
  assert.deepEqual(validateWriteReceipt(value), []);
  assert.deepEqual(value.unmetCriteria, [criterion]);
});

test("WriteReceipt rejects the retired string form and unknown criterion fields", () => {
  assert.match(validateWriteReceipt(receipt([criterion.ref])).join("\n"), /structured criterion explanations/u);
  assert.match(
    validateWriteReceipt(receipt([{ ...criterion, guessed: true }])).join("\n"),
    /structured criterion explanations/u,
  );
  assert.match(
    validateWriteReceipt(receipt([{ ...criterion, explain: "" }])).join("\n"),
    /structured criterion explanations/u,
  );
});
