// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { authorizationPort, currentActionEnvelopeVersion } from "../../kernel/src/index.ts";
import { lifecycleHarness, owner } from "./task-lifecycle-test-harness.ts";

test("event saga rejects a second executor and self-review, then completes on Review plus consent", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await assert.rejects(harness.start("execution-2", "op-start-second"), /effective lease|active execution/iu);
    await harness.submit("execution-1");
    await assert.rejects(harness.complete("execution-1", "op-complete-early"), /approved|in_review/iu);

    const selfReview = authorizationPort.authorize(
      {
        version: currentActionEnvelopeVersion,
        actionId: "action-review-self",
        kind: "execution.review",
        target: "execution/execution-1",
        actor: owner,
        authorizationRef: "default@3",
        idempotencyKey: "review-self",
      },
      {
        commandClasses: ["arbiter"],
        target: { executionActor: owner, runtimeBinding: null },
        evaluatedAtCut: "canonical:3",
      },
    );
    assert.equal(selfReview.outcome, "denied");
    assert.equal(
      selfReview.bindingsUsed.find((binding) => binding.predicate === "reviewIndependence")?.satisfied,
      false,
    );

    await harness.review("execution-1", "anti_entropy", "approved");
    await harness.consent("execution-1");
    const completed = await harness.complete("execution-1");
    assert.equal(completed.outcome, "applied");
    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.executions[0]?.state, "accepted");
    assert.deepEqual(completed.snapshot.executions[0]?.submission?.outputs, []);
  } finally {
    harness.cleanup();
  }
});
