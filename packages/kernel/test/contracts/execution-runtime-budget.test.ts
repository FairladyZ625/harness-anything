// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  executionRuntimeBudgetRefusal,
  executionRuntimeBudgetPolicy,
} from "../../src/domain/task-submission-policy.ts";

const attempts = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ runtimeSessionId: `session-${index}`, totalTokens: 20 }));

test("Execution allows its sixth attempt and refuses its seventh across groups", () => {
  assert.equal(executionRuntimeBudgetPolicy.defaultValue.maxAttempts, 6);
  assert.equal(executionRuntimeBudgetRefusal(attempts(5)), null);
  const refusal = executionRuntimeBudgetRefusal(attempts(6));
  assert.equal(refusal?.code, "execution_budget_exceeded");
  assert.match(refusal!.message, /6\/6 attempts/u);
  assert.match(refusal!.message, /owner\/CEO/u);
  assert.equal(executionRuntimeBudgetRefusal(attempts(30))?.code, "execution_budget_exceeded");
});

test("optional cumulative token ceiling stops admission at equality, not just above it", () => {
  const budget = { maxAttempts: 6, maxTokens: 100 };
  assert.equal(executionRuntimeBudgetRefusal(attempts(4), budget), null);
  assert.equal(executionRuntimeBudgetRefusal(attempts(5), budget)?.code, "execution_budget_exceeded");
  assert.equal(
    executionRuntimeBudgetRefusal([{ runtimeSessionId: "a", totalTokens: 101 }], budget)?.code,
    "execution_budget_exceeded",
  );
  assert.equal(executionRuntimeBudgetRefusal([{ runtimeSessionId: "a", totalTokens: 100000000 }]), null);
});

test("re-settlement or current-attempt metrics do not double count a session", () => {
  const repeated = [
    { runtimeSessionId: "same", totalTokens: 40 },
    { runtimeSessionId: "same", totalTokens: 50 },
  ];
  assert.equal(executionRuntimeBudgetRefusal(repeated, { maxAttempts: 2, maxTokens: 60 }), null);
  assert.equal(
    executionRuntimeBudgetRefusal(repeated, { maxAttempts: 2, maxTokens: 50 })?.code,
    "execution_budget_exceeded",
  );
});
