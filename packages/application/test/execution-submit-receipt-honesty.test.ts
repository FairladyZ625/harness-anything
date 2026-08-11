// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleHarness } from "./task-lifecycle-test-harness.ts";

test("an authored submit with failed projection reports pending and a safe read converges it", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    harness.failNextProjection();
    const receipt = await harness.submit("execution-1");

    assert.equal(receipt.outcome, "pending");
    assert.match(receipt.nextAction ?? "", /retry task lifecycle read/u);
    assert.equal(harness.eventStore.read().events.at(-1)?.type, "execution_submitted");
    const recovered = await harness.service.read("task-1");
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.snapshot.executions[0]?.state, "submitted");
  } finally {
    harness.cleanup();
  }
});
