// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskLifecycleCommand } from "../../kernel/src/index.ts";
import { commitSha, lifecycleHarness, owner } from "./task-lifecycle-test-harness.ts";

test("event saga rejects a second executor and self-review, then completes on two approvals", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await assert.rejects(harness.start("execution-2", "op-start-second"), /effective lease|active execution/iu);
    await harness.submit("execution-1");
    await assert.rejects(harness.complete("execution-1", "op-complete-early"), /approved|in_review/iu);

    await assert.rejects(harness.service.execute({ ...normalizeTaskLifecycleCommand(harness.rootDir, owner, {
      type: "RecordReview", taskId: "task-1", executionId: "execution-1", reviewId: "review-self",
      kind: "anti_entropy", verdict: "approved", actorRole: "anti_entropy", reason: "self review",
      evidenceChecked: [], commitSha, iteration: 0, archiveWarningsAcknowledged: false
    }), eventId: "event-review-self", workspaceRevision: 4,
      occurredAt: "2026-08-11T00:04:00.000Z"
    }, {
      expectedRevision: 3, actorBinding: owner, capability: "anti-entropy@v1",
      capabilityRef: "cap-self", archiveWarningsPresent: false
    }), /cannot review itself/iu);

    await harness.review("execution-1", "anti_entropy", "approved");
    await harness.review("execution-1", "acceptance", "approved");
    const completed = await harness.complete("execution-1");
    assert.equal(completed.outcome, "applied");
    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.executions[0]?.state, "accepted");
    assert.deepEqual(completed.snapshot.executions[0]?.submission?.evidenceRefs, []);
  } finally {
    harness.cleanup();
  }
});
