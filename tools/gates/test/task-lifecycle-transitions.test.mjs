// harness-test-tier: contract
// Frozen input update authorized by dec_4190D5EA63D9DD208CE946F133 and dec_5EC2631352B17EE2BF4979E37E;
// adjudicate surface removed under dec_E369B8616F50A6208B293997E7 CH5: the rework reopen folded into
// RecordReview with the repository rework budget on its proof.
import { emptyCompletionContract } from "../../../packages/kernel/test/domain/completion.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reduceTaskEvent,
  reviewDigest,
  serializeTaskEvent,
  TaskLifecycleContractError,
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../../packages/kernel/src/domain/task-graph.ts";
import { submissionDigest, TASK_LEASE_BROKER_CONTRACT } from "../../../packages/kernel/src/domain/execution.ts";

const owner = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "owner-agent" } };
const executor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker-agent" } };
const reviewer = { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "review-agent" } };
const outsider = { principal: { personId: "person-outsider" }, executor: null };
const commit0 = "0123456789abcdef0123456789abcdef01234567";
const commit1 = "1123456789abcdef0123456789abcdef01234567";
const content0 = `sha256:${"a".repeat(64)}`;

function command(actor, revision, intent, suffix = intent.type) {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor, source: "local", expectedRevision: revision - 1 },
      intent,
    ),
    eventId: `evt-${suffix}-${revision}`,
    workspaceRevision: revision,
    occurredAt: `2026-08-11T00:00:${String(revision).padStart(2, "0")}.000Z`,
  };
}

function create(revision = 1) {
  return command(
    owner,
    revision,
    {
      type: "CreateReplayTask",
      taskId: "task-1",
      title: "Replay task",
      taskClass: "standard",
      graph: REPLAY_TASK_GRAPH,
      completionGateIds: [],
      presetSnapshotDigest: null,
    },
    "create",
  );
}
function createProof() {
  return { taskIdUnique: true, actorBinding: owner };
}
function start(revision, executionId = "execution-0") {
  return command(executor, revision, { type: "StartExecution", taskId: "task-1", executionId }, `start-${executionId}`);
}
function startProof(executionId = "execution-0") {
  return {
    actorBinding: executor,
    deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
    reservation: {
      taskId: "task-1",
      executionId,
      expiresAt: "2026-08-11T01:00:00.000Z",
      ttlMs: 1_800_000,
      previousHolder: null,
      reason: "initial_claim",
      version: 1,
    },
  };
}
function transition(revision, status, reason = `Transition to ${status}`, force = status === "cancelled") {
  return command(
    owner,
    revision,
    { type: "TransitionTask", taskId: "task-1", status, reason, force },
    `transition-${status}`,
  );
}
const reviewRequiredGates = { review: true, consent: true, factDisposition: true };
function submission(commitSha = commit0, closeoutGates = reviewRequiredGates) {
  return {
    completionClaim: "Implementation is ready for review.",
    deliverables: ["kernel lifecycle"],
    outputs: ["typed event"],
    verificationNotes: ["contract tests"],
    knownGaps: [],
    residualRisks: [],
    commitSha,
    completionContract: { ...emptyCompletionContract, closeoutGates, gates: [] },
  };
}
function submit(revision, executionId = "execution-0", commitSha = commit0, closeoutGates = reviewRequiredGates) {
  return command(
    executor,
    revision,
    { type: "SubmitExecution", taskId: "task-1", executionId, submission: submission(commitSha, closeoutGates) },
    `submit-${executionId}`,
  );
}
function submitProof() {
  return { actorBinding: executor, leaseVersion: 1, sessionDisposition: "complete" };
}
function review(
  revision,
  {
    verdict = "approved",
    executionId = "execution-0",
    commitSha = commit0,
    iteration = 0,
    actor = reviewer,
    reviewId = `review-${executionId}`,
    contentDigest = content0,
  } = {},
) {
  return command(
    actor,
    revision,
    {
      type: "RecordReview",
      taskId: "task-1",
      executionId,
      reviewId,
      verdict,
      reason:
        verdict === "changes_requested"
          ? "A concrete correction is required."
          : "The submitted content cut is approved.",
      evidenceChecked: ["tests"],
      commitSha,
      iteration,
      contentDigest,
      submissionDigest: submissionDigest(submission(commitSha)),
    },
    `${reviewId}-${verdict}`,
  );
}
function reviewProof(actor = reviewer, reworkBudget = 2) {
  return {
    actorBinding: actor,
    capability: "execution-review@v1",
    capabilityRef: "capability:review",
    reworkBudget,
  };
}
function consent(revision, recorded, actor = owner) {
  return command(
    actor,
    revision,
    {
      type: "RecordReviewConsent",
      taskId: "task-1",
      executionId: recorded.executionId,
      reviewId: recorded.reviewId,
      consentId: `consent-${recorded.reviewId}`,
      reviewDigest: reviewDigest(recorded),
      contentDigest: recorded.contentDigest,
    },
    `consent-${recorded.reviewId}`,
  );
}
function consentProof(actor = owner) {
  return { actorBinding: actor, capability: "execution-consent@v1", capabilityRef: "capability:owner-consent" };
}
function complete(revision, executionId = "execution-0") {
  return command(owner, revision, { type: "CompleteTask", taskId: "task-1", executionId }, `complete-${executionId}`);
}
function completeProof() {
  return {
    capability: "task-complete@v1",
    capabilityRef: "capability:complete",
    actorRole: "owner",
    noActiveLease: true,
    closeoutGates: { review: true, consent: true, factDisposition: true },
    gateReceipts: [],
  };
}

function firstRound() {
  const created = applyTransition(emptyTaskLifecycleSnapshot(), create(), createProof());
  const started = applyTransition(created.snapshot, start(2), startProof());
  // A review-required cut enters in_review directly at submit; the reviewer records against it.
  const submitted = applyTransition(started.snapshot, submit(3), submitProof());
  const approved = applyTransition(submitted.snapshot, review(4), reviewProof());
  const recorded = approved.snapshot.reviews[0];
  const consented = applyTransition(approved.snapshot, consent(5, recorded), consentProof());
  return { created, started, submitted, approved, recorded, consented };
}

test("G10 lease broker keeps one positive capacity ceiling", () => {
  assert.deepEqual(TASK_LEASE_BROKER_CONTRACT, { capacity: 32 });
  assert.equal(Object.isFrozen(TASK_LEASE_BROKER_CONTRACT), true);
});

test("G10 block, unblock, and cancel are catalog transitions while unrelated activation stays refused", () => {
  const created = applyTransition(emptyTaskLifecycleSnapshot(), create(), createProof());
  const blocked = applyTransition(created.snapshot, transition(2, "blocked"), {});
  assert.equal(blocked.snapshot.task.status, "blocked");
  assert.deepEqual(blocked.event.payload.mutation, {
    command: "transition",
    reason: "Transition to blocked",
    fields: ["status"],
  });
  assert.deepEqual(
    reduceTaskEvent(created.snapshot, blocked.event),
    blocked.snapshot,
    "the unchanged task_transitioned event shape must replay exactly",
  );
  const forcedBlock = applyTransition(created.snapshot, transition(2, "blocked", "", true), {});
  assert.equal(forcedBlock.snapshot.task.status, "blocked");
  assert.equal(forcedBlock.event.payload.mutation.reason, "Explicit lifecycle transition to blocked");
  const unblocked = applyTransition(blocked.snapshot, transition(3, "active"), {});
  assert.equal(unblocked.snapshot.task.status, "active");
  assert.deepEqual(unblocked.event.payload.mutation, {
    command: "transition",
    reason: "Transition to active",
    fields: ["status"],
  });
  assert.deepEqual(reduceTaskEvent(blocked.snapshot, unblocked.event), unblocked.snapshot);
  assert.throws(
    () => applyTransition(created.snapshot, transition(2, "active"), {}),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );

  const cancelled = applyTransition(blocked.snapshot, transition(3, "cancelled", "Scope was withdrawn", true), {});
  assert.equal(cancelled.snapshot.task.status, "cancelled");
  assert.deepEqual(reduceTaskEvent(blocked.snapshot, cancelled.event), cancelled.snapshot);
  assert.throws(
    () => applyTransition(blocked.snapshot, transition(3, "cancelled", "", false), {}),
    /auditable reason/u,
  );

  const started = applyTransition(created.snapshot, start(2), startProof());
  assert.throws(() => applyTransition(started.snapshot, transition(3, "blocked"), {}), /unleased/u);
  const { submitted } = firstRound();
  // A cut at the review gate is not blockable: the corridor (review verdicts or cancel)
  // owns every exit, so blocked->active can never skip the audited rework round.
  assert.throws(
    () => applyTransition(submitted.snapshot, transition(4, "blocked"), {}),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  assert.throws(
    () => applyTransition(submitted.snapshot, transition(4, "active"), {}),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
});

test("G10 review-lifted submit atomically finalizes Execution, releases lease, and lands in submitted", () => {
  const { started } = firstRound();
  const result = applyTransition(
    started.snapshot,
    submit(3, "execution-0", commit0, { review: false, consent: false, factDisposition: false }),
    submitProof(),
  );
  assert.deepEqual(
    {
      execution: result.snapshot.executions[0].state,
      packet: result.snapshot.executions[0].submission,
      lease: result.snapshot.lease,
      status: result.snapshot.task.status,
      node: result.snapshot.task.currentNode,
      edge: result.snapshot.edgesTaken[0].edgeId,
    },
    {
      execution: "submitted",
      packet: submission(commit0, { review: false, consent: false, factDisposition: false }),
      lease: null,
      status: "submitted",
      node: "review",
      edge: "implementation-submitted",
    },
  );
  assert.deepEqual(result.event.payload.execution, result.snapshot.executions[0]);

  for (const field of [
    "completionClaim",
    "deliverables",
    "outputs",
    "verificationNotes",
    "knownGaps",
    "residualRisks",
    "commitSha",
  ]) {
    const packet = submission(commit0, { review: false, consent: false, factDisposition: false });
    delete packet[field];
    const before = structuredClone(started.snapshot);
    assert.throws(
      () =>
        applyTransition(
          started.snapshot,
          command(
            executor,
            3,
            { type: "SubmitExecution", taskId: "task-1", executionId: "execution-0", submission: packet },
            `missing-${field}`,
          ),
          submitProof(),
        ),
      TaskLifecycleContractError,
      field,
    );
    assert.deepEqual(started.snapshot, before, `${field} must be zero-write`);
  }
  assert.throws(
    () => applyTransition(started.snapshot, submit(3), { ...submitProof(), leaseVersion: 2 }),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
});

test("G10 append-only Reviews and content-pinned consent selection preserve completion prerequisites", () => {
  const { submitted, approved, recorded } = firstRound();
  assert.equal(approved.snapshot.reviews.length, 1);
  assert.equal(approved.snapshot.consents.length, 0);
  assert.deepEqual(
    {
      executionId: recorded.executionId,
      commitSha: recorded.commitSha,
      iteration: recorded.iteration,
      contentDigest: recorded.contentDigest,
      actor: recorded.actor,
    },
    { executionId: "execution-0", commitSha: commit0, iteration: 0, contentDigest: content0, actor: reviewer },
  );
  const transportBoundReview = applyTransition(
    submitted.snapshot,
    review(4, { actor: executor }),
    reviewProof(executor),
  );
  assert.deepEqual(transportBoundReview.snapshot.reviews[0].actor, executor);
  assert.throws(
    () => applyTransition(submitted.snapshot, review(4, { actor: executor }), reviewProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
  // A review-lifted cut never enters the corridor: status submitted refuses RecordReview.
  const lifted = applyTransition(
    firstRound().started.snapshot,
    submit(3, "execution-0", commit0, { review: false, consent: false, factDisposition: false }),
    submitProof(),
  );
  assert.throws(
    () => applyTransition(lifted.snapshot, review(4), reviewProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  const dismissed = applyTransition(
    approved.snapshot,
    review(5, { verdict: "dismissed", reviewId: "review-dismissed" }),
    reviewProof(),
  );
  const selected = applyTransition(dismissed.snapshot, review(6, { reviewId: "review-selected" }), reviewProof());
  const selectedReview = selected.snapshot.reviews.at(-1);
  assert.deepEqual(
    selected.snapshot.reviews.map(({ reviewId, verdict }) => ({ reviewId, verdict })),
    [
      { reviewId: recorded.reviewId, verdict: "approved" },
      { reviewId: "review-dismissed", verdict: "dismissed" },
      { reviewId: "review-selected", verdict: "approved" },
    ],
  );
  assert.throws(
    () => applyTransition(selected.snapshot, review(7, { reviewId: "review-selected" }), reviewProof()),
    /new review id/u,
  );
  assert.throws(
    () => applyTransition(selected.snapshot, complete(7), completeProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  assert.throws(
    () =>
      applyTransition(
        { ...selected.snapshot, legacyReviewPath: "tasks/task-1/review.md" },
        complete(7),
        completeProof(),
      ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );

  const consented = applyTransition(selected.snapshot, consent(7, selectedReview), consentProof());
  const pinned = consented.snapshot.consents[0];
  assert.deepEqual(
    {
      executionId: pinned.executionId,
      reviewId: pinned.reviewId,
      reviewDigest: pinned.reviewDigest,
      contentDigest: pinned.contentDigest,
      actor: pinned.actor,
      source: pinned.source,
    },
    {
      executionId: selectedReview.executionId,
      reviewId: selectedReview.reviewId,
      reviewDigest: reviewDigest(selectedReview),
      contentDigest: selectedReview.contentDigest,
      actor: owner,
      source: "local",
    },
  );
  for (const mutation of [
    { reviewDigest: `sha256:${"b".repeat(64)}` },
    { contentDigest: `sha256:${"c".repeat(64)}` },
    { executionId: "execution-other" },
    { reviewId: "review-other" },
  ]) {
    const bad = { ...consent(7, selectedReview), ...mutation };
    assert.throws(() => applyTransition(selected.snapshot, bad, consentProof()), TaskLifecycleContractError);
  }
  const transportBound = applyTransition(
    selected.snapshot,
    consent(7, selectedReview, outsider),
    consentProof(outsider),
  );
  assert.deepEqual(transportBound.snapshot.consents[0].actor, outsider);
  assert.throws(
    () => applyTransition(selected.snapshot, consent(7, selectedReview, outsider), consentProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
  assert.equal(applyTransition(consented.snapshot, complete(8), completeProof()).snapshot.task.status, "done");
});

test("G10 exhaustive phase table rejects every command outside its canonical predecessor", () => {
  const round = firstRound();
  // A changes_requested verdict below the rework budget reopens the round in the same write.
  const returned = applyTransition(
    round.submitted.snapshot,
    review(4, { verdict: "changes_requested", reviewId: "review-reject" }),
    reviewProof(),
  );
  const completed = applyTransition(round.consented.snapshot, complete(6), completeProof());
  const states = [
    ["missing", emptyTaskLifecycleSnapshot(), new Set(["CreateReplayTask"])],
    ["planned", round.created.snapshot, new Set(["StartExecution", "TransitionTask"])],
    ["active", round.started.snapshot, new Set(["SubmitExecution", "TransitionTask"])],
    ["in_review", round.submitted.snapshot, new Set(["RecordReview", "TransitionTask"])],
    ["approved", round.approved.snapshot, new Set(["RecordReview", "RecordReviewConsent", "TransitionTask"])],
    [
      "consented",
      round.consented.snapshot,
      new Set(["RecordReview", "RecordReviewConsent", "CompleteTask", "TransitionTask"]),
    ],
    ["returned", returned.snapshot, new Set(["StartExecution", "TransitionTask"])],
    ["done", completed.snapshot, new Set()],
  ];
  const types = [
    "CreateReplayTask",
    "StartExecution",
    "TransitionTask",
    "SubmitExecution",
    "RecordReview",
    "RecordReviewConsent",
    "CompleteTask",
  ];
  for (const [label, snapshot, allowed] of states)
    for (const type of types) {
      if (allowed.has(type)) continue;
      const revision = snapshot.revision + 1;
      const recorded = snapshot.reviews.find((value) => value.verdict === "approved") ?? round.recorded;
      const entries = {
        CreateReplayTask: [create(), createProof()],
        StartExecution: [start(revision, `execution-${label}`), startProof(`execution-${label}`)],
        TransitionTask: [transition(revision, "blocked"), {}],
        SubmitExecution: [submit(revision), submitProof()],
        RecordReview: [review(revision), reviewProof()],
        RecordReviewConsent: [consent(revision, recorded), consentProof()],
        CompleteTask: [complete(revision), completeProof()],
      };
      assert.throws(
        () => applyTransition(snapshot, ...entries[type]),
        TaskLifecycleContractError,
        `${label} -> ${type}`,
      );
    }
});

test("G10 a changes_requested verdict reopens rework below the budget and only records at it", () => {
  const { submitted } = firstRound();
  // Below the repository rework budget the verdict itself reopens the implementation round:
  // one write records the review, closes the cut, bumps the iteration, and walks the return edge.
  const reopened = applyTransition(
    submitted.snapshot,
    review(4, { verdict: "changes_requested", reviewId: "review-reject" }),
    reviewProof(),
  );
  assert.deepEqual(
    {
      status: reopened.snapshot.task.status,
      node: reopened.snapshot.task.currentNode,
      iteration: reopened.snapshot.task.iteration,
      execution: reopened.snapshot.executions[0].state,
      closedAt: reopened.snapshot.executions[0].closedAt,
      lease: reopened.snapshot.lease,
      reviews: reopened.snapshot.reviews.length,
      edge: reopened.snapshot.edgesTaken.at(-1).edgeId,
    },
    {
      status: "active",
      node: "implementation",
      iteration: 1,
      execution: "changes_requested",
      closedAt: reopened.event.occurredAt,
      lease: null,
      reviews: 1,
      edge: "review-changes-requested",
    },
  );
  assert.equal(reopened.event.type, "review_recorded");
  assert.deepEqual(reduceTaskEvent(submitted.snapshot, reopened.event), reopened.snapshot);
  // At the budget the same verdict only records: the cut stays at the gate for the owner.
  const started = applyTransition(reopened.snapshot, start(5, "execution-1"), startProof("execution-1"));
  const resubmitted = applyTransition(started.snapshot, submit(6, "execution-1", commit1), submitProof());
  const capped = applyTransition(
    resubmitted.snapshot,
    review(7, {
      verdict: "changes_requested",
      executionId: "execution-1",
      commitSha: commit1,
      iteration: 1,
      reviewId: "review-reject-1",
    }),
    reviewProof(reviewer, 1),
  );
  assert.deepEqual(
    {
      status: capped.snapshot.task.status,
      node: capped.snapshot.task.currentNode,
      iteration: capped.snapshot.task.iteration,
      execution: capped.snapshot.executions[1].state,
      reviews: capped.snapshot.reviews.length,
      edges: capped.snapshot.edgesTaken.length,
    },
    { status: "in_review", node: "review", iteration: 1, execution: "submitted", reviews: 2, edges: 3 },
  );
  assert.deepEqual(reduceTaskEvent(resubmitted.snapshot, capped.event), capped.snapshot);
  // The proof without a usable budget is refused before any write.
  assert.throws(
    () =>
      applyTransition(submitted.snapshot, review(4), {
        actorBinding: reviewer,
        capability: "execution-review@v1",
        capabilityRef: "capability:review",
        reworkBudget: 0,
      }),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
});

test("G34 replay preserves report-to-auto-rework to new execution to approved consent to complete", () => {
  const round = firstRound();
  // The reviewer's verdict is itself the return order below the budget: the cut closes and the
  // implementation iteration reopens in the same review_recorded write.
  const rejected = applyTransition(
    round.submitted.snapshot,
    review(4, { verdict: "changes_requested", reviewId: "review-reject" }),
    reviewProof(),
  );
  assert.deepEqual(
    {
      status: rejected.snapshot.task.status,
      node: rejected.snapshot.task.currentNode,
      iteration: rejected.snapshot.task.iteration,
      execution: rejected.snapshot.executions[0].state,
      lease: rejected.snapshot.lease,
    },
    { status: "active", node: "implementation", iteration: 1, execution: "changes_requested", lease: null },
  );
  const startedAgain = applyTransition(rejected.snapshot, start(5, "execution-1"), startProof("execution-1"));
  const submittedAgain = applyTransition(startedAgain.snapshot, submit(6, "execution-1", commit1), submitProof());
  const approvedAgain = applyTransition(
    submittedAgain.snapshot,
    review(7, { executionId: "execution-1", commitSha: commit1, iteration: 1, reviewId: "review-execution-1" }),
    reviewProof(),
  );
  const recorded = approvedAgain.snapshot.reviews.at(-1);
  const consentedAgain = applyTransition(approvedAgain.snapshot, consent(8, recorded), consentProof());
  const completed = applyTransition(consentedAgain.snapshot, complete(9, "execution-1"), completeProof());
  const events = [
    round.created.event,
    round.started.event,
    round.submitted.event,
    rejected.event,
    startedAgain.event,
    submittedAgain.event,
    approvedAgain.event,
    consentedAgain.event,
    completed.event,
  ];
  let replayed = emptyTaskLifecycleSnapshot();
  for (const event of events) {
    assert.doesNotThrow(() => serializeTaskEvent(event));
    replayed = reduceTaskEvent(replayed, event);
  }
  assert.deepEqual(replayed, completed.snapshot);
  assert.equal(replayed.task.status, "done");
  assert.equal(replayed.executions[1].state, "accepted");
  // A review-lifted cut never enters the corridor: status submitted refuses RecordReview.
  const liftedAgain = applyTransition(
    startedAgain.snapshot,
    submit(6, "execution-1", commit1, { review: false, consent: false, factDisposition: false }),
    submitProof(),
  );
  assert.throws(
    () =>
      applyTransition(
        liftedAgain.snapshot,
        review(7, { executionId: "execution-1", commitSha: commit1, iteration: 1, reviewId: "review-lifted" }),
        reviewProof(),
      ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
});
