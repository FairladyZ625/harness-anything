// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskLifecycleCommand } from "../../kernel/src/index.ts";
import { commitSha, lifecycleHarness, reviewer } from "./task-lifecycle-test-harness.ts";

test("approval retry reuses Review identity and ignores transport-only metadata", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    const command = { ...normalizeTaskLifecycleCommand({ workspaceId: harness.rootDir, actor: reviewer, source: "local", expectedRevision: 3 }, {
      type: "RecordReview" as const, taskId: "task-1", executionId: "execution-1", reviewId: "review-ae",
      verdict: "approved" as const,
      reason: "approved", evidenceChecked: [], commitSha, iteration: 0,
      contentDigest: `sha256:${"b".repeat(64)}` as const
    }), eventId: "event-review-ae",
      workspaceRevision: 4, occurredAt: "2026-08-11T00:04:00.000Z", transport: { attempt: 1 }
    };
    const proof = {
      actorBinding: reviewer, capability: "execution-review@v1" as const,
      capabilityRef: "cap-ae"
    };
    const first = await harness.service.execute(command, proof);
    const second = await harness.service.execute({ ...command, transport: { attempt: 2 } }, proof);

    assert.equal(first.event?.type, "review_recorded");
    assert.equal(second.event?.eventId, first.event?.eventId);
    assert.equal(harness.eventStore.read().events.length, 4);
    assert.equal(second.snapshot.reviews[0]?.reviewId, "review-ae");
  } finally {
    harness.cleanup();
  }
});

test("idempotent retry rejects source, workspace, expectedRevision, digest drift, and opId drift", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    const command = { ...normalizeTaskLifecycleCommand({ workspaceId: harness.rootDir, actor: reviewer, source: "local", expectedRevision: 3 }, {
      type: "RecordReview" as const, taskId: "task-1", executionId: "execution-1", reviewId: "review-drift",
      verdict: "approved" as const,
      reason: "approved", evidenceChecked: [], commitSha, iteration: 0, contentDigest: `sha256:${"b".repeat(64)}` as const
    }), eventId: "event-review-drift", workspaceRevision: 4, occurredAt: "2026-08-11T00:04:00.000Z" };
    const proof = { actorBinding: reviewer, capability: "execution-review@v1" as const,
      capabilityRef: "cap-drift" };
    await harness.service.execute(command, proof);
    const drifts = [
      { source: "remote_direct" as const },
      { workspaceId: `${harness.rootDir}-other` },
      { expectedRevision: 2 },
      { commandDigest: `sha256:${"0".repeat(64)}` as const },
      { opId: `op_${"f".repeat(64)}` }
    ];
    for (const drift of drifts) {
      await assert.rejects(() => harness.service.execute({ ...command, ...drift }, proof));
    }
    assert.equal(harness.eventStore.read().events.length, 4);
  } finally {
    harness.cleanup();
  }
});
