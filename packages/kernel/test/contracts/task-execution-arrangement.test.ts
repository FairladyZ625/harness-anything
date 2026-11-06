// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { implementer, lifecycleFixture } from "../store/task-lifecycle-fixture.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  validateTransition,
  canStartExecution,
  reduceTaskEvent,
  emptyTaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";
import { submissionDigest } from "../../src/domain/execution.ts";

const proof = { actorBinding: implementer, capability: "task-rework@v1" as const, capabilityRef: "owner-arrangement" };
function setup() {
  const snapshot = lifecycleFixture({ complete: false })
    .events.slice(0, 3)
    .reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const submission = snapshot.executions[0]!.submission!;
  const command = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
      {
        type: "ReworkTask",
        taskId: "task-1",
        executionId: "execution-1",
        reason: "Owner arranges the returned round",
        takeover: true as const,
        submissionDigest: submissionDigest(submission),
      },
    ),
    eventId: "arrange-event",
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-11-05T01:00:00.000Z",
  };
  return { snapshot, command };
}

test("takeover records an arrangement without returning the cut or changing its review result", () => {
  const { snapshot, command } = setup(),
    result = applyTransition(snapshot, command, proof);
  assert.equal(result.event.type, "task_amended");
  assert.equal(result.snapshot.task?.iteration, snapshot.task?.iteration);
  assert.equal(result.snapshot.task?.status, snapshot.task?.status);
  assert.deepEqual(result.snapshot.executions, snapshot.executions);
});

test("takeover rejects a stale submission digest even when the execution id is unchanged", () => {
  const { snapshot, command } = setup();
  const stale = {
    ...normalizeTaskLifecycleCommand(
      {
        workspaceId: command.workspaceId,
        actor: command.actor,
        source: command.source,
        expectedRevision: snapshot.revision,
      },
      {
        type: "ReworkTask",
        taskId: command.taskId,
        executionId: command.executionId,
        reason: command.reason,
        takeover: true as const,
        submissionDigest: `sha256:${"f".repeat(64)}` as `sha256:${string}`,
      },
    ),
    eventId: command.eventId,
    workspaceRevision: command.workspaceRevision,
    occurredAt: command.occurredAt,
  };
  assert.ok(validateTransition(snapshot, stale, proof).some((issue) => issue.code === "invalid_transition"));
});

test("a returned arrangement cannot start before its handoff CAS, and another session cannot acquire it afterwards", () => {
  const { snapshot, command } = setup(),
    reserved = applyTransition(snapshot, command, proof).snapshot;
  const returnedCommand = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: command.workspaceId, actor: implementer, source: "local", expectedRevision: reserved.revision },
      {
        type: "ReworkTask",
        taskId: command.taskId,
        executionId: command.executionId,
        reason: "Return the low-risk cut",
      },
    ),
    eventId: "return",
    workspaceRevision: reserved.revision + 1,
    occurredAt: command.occurredAt,
  };
  const returned = applyTransition(reserved, returnedCommand, proof).snapshot;
  assert.equal(canStartExecution(returned, "next"), false);
  const handoff = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: command.workspaceId, actor: implementer, source: "local", expectedRevision: returned.revision },
      {
        type: "ReworkTask",
        taskId: command.taskId,
        executionId: command.executionId,
        reason: command.reason,
        handoffId: reserved.task!.executionArrangement!.id,
      },
    ),
    eventId: "handoff",
    workspaceRevision: returned.revision + 1,
    occurredAt: command.occurredAt,
  };
  const ready = applyTransition(returned, handoff, proof).snapshot;
  assert.equal(canStartExecution(ready, "next"), true);
  const other = { ...implementer, executor: { kind: "agent" as const, id: "another-session" } };
  const start = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: command.workspaceId, actor: other, source: "local", expectedRevision: ready.revision },
      {
        type: "StartExecution",
        taskId: command.taskId,
        executionId: "next",
      },
    ),
    eventId: "other-start",
    workspaceRevision: ready.revision + 1,
    occurredAt: command.occurredAt,
  };
  const issues = validateTransition(ready, start, { actorBinding: other } as never);
  assert.ok(issues.some((issue) => issue.message.includes("execution arrangement")));
});

test("amending a cut expires its reserved owner arrangement and replay preserves that expiry", async () => {
  const { snapshot, command } = setup(),
    arranged = applyTransition(snapshot, command, proof);
  const submission = { ...snapshot.executions[0]!.submission!, completionClaim: "Amended candidate" };
  const amend = {
    ...normalizeTaskLifecycleCommand(
      {
        workspaceId: command.workspaceId,
        actor: implementer,
        source: "local",
        expectedRevision: arranged.snapshot.revision,
      },
      {
        type: "SubmitExecution",
        taskId: command.taskId,
        executionId: command.executionId,
        submission,
        amend: true as const,
      },
    ),
    eventId: "amend",
    workspaceRevision: arranged.snapshot.revision + 1,
    occurredAt: command.occurredAt,
  };
  const amended = applyTransition(arranged.snapshot, amend, {
    actorBinding: implementer,
    leaseVersion: null,
    sessionDisposition: "complete",
  });
  assert.equal(amended.snapshot.task?.executionArrangement, undefined);
  const { reduceTaskEvent } = await import("../../src/domain/task-lifecycle.contract.ts");
  const replayed = reduceTaskEvent(arranged.snapshot, amended.event);
  assert.deepEqual(replayed, amended.snapshot);
});

test("low-risk takeover returns the cut and replays its arrangement atomically", () => {
  const snapshot = lifecycleFixture({
    closeoutGates: { review: false, consent: false, factDisposition: false },
  }).snapshot;
  const command = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
      {
        type: "ReworkTask",
        taskId: "task-1",
        executionId: "execution-1",
        reason: "Arrange low-risk rework",
        takeover: true as const,
        submissionDigest: submissionDigest(snapshot.executions[0]!.submission!),
      },
    ),
    eventId: "lowrisk-arrangement",
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-11-05T01:00:00.000Z",
  };
  const result = applyTransition(snapshot, command, proof);
  assert.equal(result.event.type, "submission_returned");
  assert.equal(result.snapshot.task?.iteration, 1);
  assert.equal(result.snapshot.task?.executionArrangement?.ready, false);
  assert.deepEqual(reduceTaskEvent(snapshot, result.event), result.snapshot);
});

test("approval ends a reservation without changing the approved review or completing the task", () => {
  const { snapshot, command } = setup(),
    reserved = applyTransition(snapshot, command, proof).snapshot;
  const recorded = lifecycleFixture({ complete: false }).events.find((event) => event.type === "review_recorded")!;
  assert.equal(recorded.type, "review_recorded");
  const review = recorded.payload.review;
  const approved = {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: command.workspaceId, actor: review.actor, source: "local", expectedRevision: reserved.revision },
      {
        type: "RecordReview",
        taskId: command.taskId,
        executionId: command.executionId,
        reviewId: review.reviewId,
        verdict: "approved" as const,
        findings: [],
        resolutions: [],
        reason: review.reason,
        evidenceChecked: review.evidenceChecked,
        commitSha: review.commitSha,
        iteration: review.iteration,
        contentDigest: review.contentDigest,
        submissionDigest: review.submissionDigest,
      },
    ),
    eventId: "approval",
    workspaceRevision: reserved.revision + 1,
    occurredAt: command.occurredAt,
  };
  const result = applyTransition(reserved, approved, {
    actorBinding: review.actor,
    capability: "execution-review@v1",
    capabilityRef: review.capabilityRef,
    reworkBudget: 2,
  });
  assert.equal(result.snapshot.task?.executionArrangement, undefined);
  assert.equal(result.snapshot.reviews.at(-1)?.verdict, "approved");
  assert.equal(result.snapshot.task?.status, "in_review");
  assert.deepEqual(reduceTaskEvent(reserved, result.event), result.snapshot);
});
