// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { authorizationPort, type ActionEnvelope, type AuthorizationContext } from "../../src/index.ts";
import { createWriteReceipt, validateWriteReceipt, type WriteReceipt } from "../../src/domain/write-chain.contract.ts";

const actor = { principal: { personId: "person-criteria" }, executor: null } as const;
const authorizationDecision = authorizationPort.authorize(
  {
    actionId: "action-criteria",
    kind: "task-start",
    target: "task/task-criteria",
    actor,
    idempotencyKey: "criteria",
  } satisfies ActionEnvelope,
  {
    defaultBinding: { principalPersonId: actor.principal.personId, source: "local" },
    roleBindingTargets: ["settings/repository"],
    evaluatedAt: "2026-09-01T00:00:00.000Z",
    evaluatedAtCut: "canonical:7",
    writeSource: "local",
    target: {},
  } satisfies AuthorizationContext,
);

const criterion = {
  ref: "task-lifecycle-command-transitions/canStartExecution",
  failureCode: "invalid_transition",
  explain: "The requested execution is admissible at the current Task cut.",
} as const;

function receipt(unmetCriteria: unknown): WriteReceipt {
  return {
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
  assert.deepEqual(createWriteReceipt(value).unmetCriteria, [criterion]);
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
