// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskLifecycleCommand } from "../../kernel/src/index.ts";
import { commitSha, lifecycleHarness, owner } from "./task-lifecycle-test-harness.ts";

test("event saga rejects a second executor and self-review, then completes on Review plus consent", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await assert.rejects(harness.start("execution-2", "op-start-second"), /effective lease|active execution/iu);
    await harness.submit("execution-1");
    await assert.rejects(harness.complete("execution-1", "op-complete-early"), /approved|in_review/iu);

    await assert.rejects(harness.service.execute({ ...normalizeTaskLifecycleCommand({ workspaceId: harness.rootDir, actor: owner, source: "local", expectedRevision: 3 }, {
      type: "RecordReview", taskId: "task-1", executionId: "execution-1", reviewId: "review-self",
      verdict: "approved", reason: "self review",
      evidenceChecked: [], commitSha, iteration: 0, contentDigest: `sha256:${"b".repeat(64)}`
    }), eventId: "event-review-self", workspaceRevision: 4,
      occurredAt: "2026-08-11T00:04:00.000Z"
    }, {
      actorBinding: owner, capability: "execution-review@v1",
      capabilityRef: "cap-self"
    }), /independent reviewer/iu);

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
