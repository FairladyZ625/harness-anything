// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { emptyTaskLifecycleSnapshot, reduceTaskEvent } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import type { RepoCellApiContext } from "../src/repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "../src/repo-cell-types.ts";
import { readBeforeWriteQueue } from "../src/write-queue-external-reads.ts";
import { actionCriterionFailure } from "../src/repo-cell-errors.ts";

const fixture = lifecycleFixture({ complete: false }),
  binding: RepoCellBinding = {
    actor: { principal: { personId: "person-owner" }, executor: null },
    source: "local",
  },
  forward: RepoTaskAction = {
    kind: "task-adjudicate",
    taskId: "task-1",
    executionId: "execution-1",
    forward: true,
    reason: "Mistaken second forward.",
  };

function context(snapshot: Snapshot): RepoCellApiContext {
  return { projection: { read: () => ({ snapshot, packagePath: null }) } } as unknown as RepoCellApiContext;
}

const neverFetch = async () => {
  throw new Error("the guard must not enqueue or fetch anything");
};

test("forward without a reviewer on an in-review cut is refused before the write queue", async () => {
  // task-1 sits at the review gate (status in_review) with review-execution recorded: the guard
  // answers in readBeforeWriteQueue itself, so the refusal cannot wait behind a queued publication.
  assert.equal(fixture.snapshot.task?.status, "in_review");
  await assert.rejects(
    readBeforeWriteQueue(context(fixture.snapshot), forward, binding, neverFetch),
    (error: unknown) => {
      const failure = actionCriterionFailure(error);
      assert.ok(failure, "the refusal is attributed to the adjudicate contract criterion");
      assert.equal(failure.actionId, "adjudicate");
      assert.equal(failure.criterionRef, "task-lifecycle-adjudication-transitions/adjudicate.validate");
      assert.match((error as Error).message, /Task task-1 is already in review/u);
      assert.match((error as Error).message, /ha task adjudicate task-1 --return --review-id review-execution/u);
      assert.deepEqual(failure.nextActions, [
        `ha task adjudicate task-1 --forward --reviewer <agent> --note "<why>"`,
        `ha task adjudicate task-1 --return --review-id review-execution --note "<the owner's rework instruction>"`,
      ]);
      return true;
    },
  );
});

test("a legacy submitted cut also requires an explicit reviewer before forward", async () => {
  const submitted = fixture.snapshot.task
    ? {
        ...fixture.snapshot,
        task: { ...fixture.snapshot.task, status: "submitted" as const },
      }
    : fixture.snapshot;
  assert.equal(submitted.task?.status, "submitted");
  await assert.rejects(readBeforeWriteQueue(context(submitted), forward, binding, neverFetch), (error: unknown) => {
    const failure = actionCriterionFailure(error);
    assert.ok(failure);
    assert.equal(failure.criterionRef, "task-lifecycle-adjudication-transitions/adjudicate.validate");
    assert.match((error as Error).message, /explicit --reviewer/u);
    assert.deepEqual(failure.nextActions, [
      `ha task adjudicate task-1 --forward --reviewer <agent> --note "<why>"`,
      `ha task adjudicate task-1 --return --review-id review-execution --note "<the owner's rework instruction>"`,
    ]);
    return true;
  });
});

test("an explicit reviewer selection proceeds into the write queue for submitted and in-review cuts", async () => {
  const legacySubmitted = fixture.snapshot.task
      ? {
          ...fixture.snapshot,
          task: { ...fixture.snapshot.task, status: "submitted" as const },
        }
      : fixture.snapshot,
    inReview = fixture.events.slice(0, 3).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  assert.equal(legacySubmitted.task?.status, "submitted");
  assert.equal(inReview.task?.status, "in_review");
  assert.equal(
    readBeforeWriteQueue(context(legacySubmitted), { ...forward, reviewer: "other-reviewer" }, binding, neverFetch),
    null,
    "legacy submitted cuts can still be upgraded by deliberately selecting a reviewer",
  );
  assert.equal(
    readBeforeWriteQueue(context(inReview), { ...forward, reviewer: "other-reviewer" }, binding, neverFetch),
    null,
    "the queued owner adjudication handles explicit reviewer selection",
  );
});

test("a return order never touches the pre-queue guard", () => {
  assert.equal(
    readBeforeWriteQueue(context(fixture.snapshot), { ...forward, forward: false, return: true }, binding, neverFetch),
    null,
  );
});
