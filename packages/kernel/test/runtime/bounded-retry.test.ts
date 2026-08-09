// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedRetryBudget } from "../../src/index.ts";

test("bounded retry exhausts once per episode and resets after recovery", () => {
  const exhausted: Array<{ operation: string; retriesUsed: number }> = [];
  const retry = createBoundedRetryBudget({
    operation: "publication-object-read",
    budget: { maxRetries: 1 },
    onExhausted: (event) => exhausted.push({
      operation: event.operation,
      retriesUsed: event.retriesUsed
    })
  });

  assert.equal(retry.recordFailure(new Error("first")).status, "retry-allowed");
  assert.equal(retry.recordFailure(new Error("second")).status, "budget-exhausted");
  assert.equal(retry.recordFailure(new Error("third")).status, "budget-exhausted");
  assert.deepEqual(exhausted, [{ operation: "publication-object-read", retriesUsed: 1 }]);

  retry.reset();

  assert.equal(retry.recordFailure(new Error("new episode")).status, "retry-allowed");
  assert.equal(retry.recordFailure(new Error("new episode exhausted")).status, "budget-exhausted");
  assert.equal(exhausted.length, 2);
});
