// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";
import { reduceTaskEvent } from "../../src/domain/task-lifecycle-replay.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import { submissionDigest } from "../../src/domain/execution.ts";
import { reviewDigest } from "../../src/domain/review.ts";
import type { TaskEventV1 } from "../../src/domain/task-lifecycle-event.ts";

// A cut whose changes_requested verdict the owner disposed (review-consent override) completes
// through the command path; replay must accept the same completion or projection rebuild stalls.
function overriddenCut(withDisposition: boolean) {
  const { events } = lifecycleFixture();
  const completed = events.at(-1)! as TaskEventV1;
  assert.equal(completed.type, "task_completed");
  const before = events.slice(0, -1).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const current = before.executions.at(-1)!;
  const review = { ...before.reviews.at(-1)!, verdict: "changes_requested" as const };
  const snapshot = {
    ...before,
    reviews: [...before.reviews.slice(0, -1), review],
    consents: before.consents.map((consent) =>
      consent.reviewId === review.reviewId ? { ...consent, reviewDigest: reviewDigest(review) } : consent,
    ),
    reviewDispositions: withDisposition
      ? [
          {
            schema: "review-disposition/v1" as const,
            dispositionId: "disposition-override",
            taskId: current.taskId,
            executionId: current.executionId,
            iteration: current.iteration,
            submissionDigest: submissionDigest(current.submission!),
            disposedReviewIds: [review.reviewId],
            rationale: "Owner accepts the cut over the requested changes.",
            actor: completed.actor,
            source: completed.source,
            disposedAt: completed.occurredAt,
          },
        ]
      : [],
  };
  return { snapshot, completed };
}

test("replay accepts a completion whose changes_requested review the owner disposed on this cut", () => {
  const { snapshot, completed } = overriddenCut(true);
  const replayed = reduceTaskEvent(snapshot, completed);
  assert.equal(replayed.task?.status, "done");
  assert.equal(replayed.executions.at(-1)?.state, "accepted");
});

test("replay does not rejudge a completion over an undisposed changes_requested review", () => {
  const { snapshot, completed } = overriddenCut(false);
  const replayed = reduceTaskEvent(snapshot, completed);
  assert.equal(replayed.task?.status, "done");
  assert.equal(replayed.executions.at(-1)?.state, "accepted");
});
