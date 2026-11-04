// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { implementer, lifecycleFixture } from "../store/task-lifecycle-fixture.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  validateTransition,
  type ReworkTaskCommand,
} from "../../src/domain/task-lifecycle.contract.ts";

// A low-risk cut submits review-exempt: the aggregate stays at `submitted` instead of entering
// `in_review`. The owner's semantic acceptance is still a real judgment, so the same owner return
// path that serves a review-gated cut must serve this one.
test("a review-exempt submitted cut can be returned to rework", () => {
  const fixture = lifecycleFixture({
      closeoutGates: { review: false, consent: false, factDisposition: false },
    }),
    snapshot = fixture.snapshot;
  assert.equal(snapshot.task?.status, "submitted");
  assert.equal(snapshot.executions.at(-1)?.state, "submitted");

  const revision = snapshot.revision + 1,
    command = {
      ...normalizeTaskLifecycleCommand(
        {
          workspaceId: "workspace-1",
          actor: implementer,
          source: "local",
          expectedRevision: snapshot.revision,
        },
        {
          type: "ReworkTask",
          taskId: "task-1",
          executionId: "execution-1",
          reason: "CEO semantic acceptance failed: narrow the test.",
        } satisfies ReworkTaskCommand,
      ),
      eventId: `event-${String(revision)}`,
      workspaceRevision: revision,
      occurredAt: "2026-11-04T00:10:00.000Z",
    } satisfies ReworkTaskCommand,
    proof = { actorBinding: implementer, capability: "task-rework@v1" as const, capabilityRef: "cap-rework" };

  assert.deepEqual(validateTransition(snapshot, command, proof), []);
  const result = applyTransition(snapshot, command, proof);
  assert.equal(result.event.type, "submission_returned");
  assert.equal(result.snapshot.task?.status, "active");
  assert.equal(result.snapshot.task?.currentNode, "implementation");
  assert.equal(result.snapshot.task?.iteration, 1);
  assert.equal(result.snapshot.executions.at(-1)?.state, "changes_requested");
  assert.equal(result.snapshot.lease, null);
});
