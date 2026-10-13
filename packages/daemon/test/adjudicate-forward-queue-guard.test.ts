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

test("a forward order on a cut already in review is refused before the write queue", async () => {
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
      assert.match((error as Error).message, /Task task-1 is in review/u);
      assert.match((error as Error).message, /ha task adjudicate task-1 --return --review-id review-execution/u);
      assert.deepEqual(failure.nextActions, [
        `ha task adjudicate task-1 --return --review-id review-execution --note "<the owner's rework instruction>"`,
      ]);
      return true;
    },
  );
});

test("a forward order on a cut still awaiting triage proceeds into the write queue", async () => {
  const submitted = fixture.events.slice(0, 3).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  assert.equal(submitted.task?.status, "submitted");
  assert.equal(
    readBeforeWriteQueue(context(submitted), forward, binding, neverFetch),
    null,
    "the queued kernel validation stays the authority for the triage state",
  );
});

test("a return order never touches the pre-queue guard", () => {
  assert.equal(
    readBeforeWriteQueue(context(fixture.snapshot), { ...forward, forward: false, return: true }, binding, neverFetch),
    null,
  );
});
