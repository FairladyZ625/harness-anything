// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTaskActionCapability,
  getExecutableEntityAction,
  reduceTaskEvent,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/index.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  emptyTaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";
import { implementer, lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

const standardGates = { review: false, consent: false, factDisposition: false, codeDoc: false };
const strictGates = { review: true, consent: true, factDisposition: true, codeDoc: true };

function snapshotAfter(recordedEvents: number): TaskLifecycleSnapshot {
  const fixture = lifecycleFixture();
  return fixture.events.slice(0, recordedEvents).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
}

function completeCommand(snapshot: TaskLifecycleSnapshot) {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
      {
        type: "CompleteTask",
        taskId: snapshot.task!.taskId,
        executionId: snapshot.executions[0]!.executionId,
      },
    ),
    eventId: "event-complete-profile",
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-08-11T00:06:00.000Z",
  };
}

function completeProof(closeoutGates: unknown) {
  return {
    capability: "task-complete@v1",
    capabilityRef: "cap-complete",
    actorRole: "owner",
    noActiveLease: true,
    gateReceipts: [],
    closeoutGates,
  };
}

test("standard gates complete without review or consent and record the effective gate set", () => {
  const snapshot = snapshotAfter(3);
  assert.equal(snapshot.task?.status, "in_review");
  assert.deepEqual(snapshot.reviews, []);
  const result = applyTransition(snapshot, completeCommand(snapshot), completeProof(standardGates));
  assert.equal(result.snapshot.task?.status, "done");
  assert.equal(result.event.type, "task_completed");
  assert.deepEqual(result.event.payload.closeoutGates, standardGates);
  assert.equal(reduceTaskEvent(snapshot, result.event).task?.status, "done");
});

test("strict gates still reject completion without a consent-selected approved review", () => {
  const snapshot = snapshotAfter(3);
  assert.throws(
    () => applyTransition(snapshot, completeCommand(snapshot), completeProof(strictGates)),
    /consent-selected approved Review/u,
  );
});

test("a consent-only override keeps the review gate while waiving consent", () => {
  const gates = { ...strictGates, consent: false };
  const withApprovedReview = snapshotAfter(4);
  assert.equal(withApprovedReview.reviews.length, 1);
  assert.deepEqual(withApprovedReview.consents, []);
  const result = applyTransition(withApprovedReview, completeCommand(withApprovedReview), completeProof(gates));
  assert.equal(result.snapshot.task?.status, "done");
  assert.equal(reduceTaskEvent(withApprovedReview, result.event).task?.status, "done");
  assert.throws(
    () => applyTransition(snapshotAfter(3), completeCommand(snapshotAfter(3)), completeProof(gates)),
    /consent-selected approved Review/u,
  );
});

test("completion proof must carry a well-formed closeout gate set", () => {
  const snapshot = snapshotAfter(3);
  const malformed = { review: "false", consent: true, factDisposition: true, codeDoc: true };
  for (const invalid of [undefined, {}, { review: false }, malformed])
    assert.throws(
      () => applyTransition(snapshot, completeCommand(snapshot), completeProof(invalid)),
      /closeout gate set/u,
      `gates ${JSON.stringify(invalid)} must be rejected`,
    );
});

test("legacy completion replay without recorded gates still demands consent", () => {
  const fixture = lifecycleFixture(),
    snapshot = snapshotAfter(5),
    { closeoutGates: _recorded, ...legacyPayload } = fixture.events[5]!.payload,
    legacy: TaskEventV1 = { ...fixture.events[5]!, payload: legacyPayload };
  assert.equal(fixture.events[5]!.type, "task_completed");
  assert.equal(reduceTaskEvent(snapshot, legacy).task?.status, "done");
  assert.throws(() => reduceTaskEvent({ ...snapshot, consents: [] }, legacy), /accepted task and execution state/u);
});

test("read-side complete capability follows the effective closeout gate set", () => {
  const action = getExecutableEntityAction("task-complete");
  if (!action) throw new Error("The task-complete Action contract is unavailable.");
  const readiness = (closeoutGates?: typeof standardGates) =>
    evaluateTaskActionCapability({ action, snapshot: snapshotAfter(3), actor: implementer, closeoutGates }).find(
      ({ criterionRef }) => criterionRef === "closeout-readiness/closeoutReadiness",
    )!.status;
  assert.equal(readiness(standardGates), "met");
  assert.equal(readiness(strictGates), "unmet");
  assert.equal(readiness(undefined), "unmet", "a caller that passes no gate set keeps the strict read");
});
