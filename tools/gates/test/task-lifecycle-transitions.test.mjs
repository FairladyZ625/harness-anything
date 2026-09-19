// harness-test-tier: contract
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
function submission(commitSha = commit0) {
  return {
    completionClaim: "Implementation is ready for review.",
    deliverables: ["kernel lifecycle"],
    outputs: ["typed event"],
    verificationNotes: ["contract tests"],
    knownGaps: [],
    residualRisks: [],
    commitSha,
    completionContract: { gates: [] },
  };
}
function submit(revision, executionId = "execution-0", commitSha = commit0) {
  return command(
    executor,
    revision,
    { type: "SubmitExecution", taskId: "task-1", executionId, submission: submission(commitSha) },
    `submit-${executionId}`,
  );
}
function submitProof() {
  return { actorBinding: executor, leaseVersion: 1, sessionDisposition: "complete" };
}
function adjudicate(revision, decision = "forward", reason = "Owner triage note", reviewId = undefined) {
  return command(
    owner,
    revision,
    {
      type: "AdjudicateSubmission",
      taskId: "task-1",
      executionId: "execution-0",
      decision,
      reason,
      ...(reviewId === undefined ? {} : { reviewId }),
    },
    `adjudicate-${decision}`,
  );
}
function adjudicateProof(actor = owner) {
  return { actorBinding: actor, capability: "task-adjudicate@v1", capabilityRef: "capability:adjudicate" };
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
function reviewProof(actor = reviewer) {
  return { actorBinding: actor, capability: "execution-review@v1", capabilityRef: "capability:review" };
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
function reconcile(
  revision,
  executionId = "execution-0",
  commitSha = commit0,
  iteration = 0,
  paths = ["packages/kernel/src/domain/task.ts"],
) {
  return command(
    executor,
    revision,
    {
      type: "ReconcileCodeDoc",
      taskId: "task-1",
      executionId,
      witnessId: `witness-${revision}`,
      commitSha,
      iteration,
      paths,
    },
    `reconcile-${revision}`,
  );
}
function reconcileProof() {
  return {
    actorBinding: executor,
    capability: "code-doc-reconcile@v1",
    capabilityRef: "capability:code-doc",
    commitPaths: { commitSha: commit0, paths: ["packages/kernel/src/domain/task.ts"] },
  };
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
    closeoutGates: { review: true, consent: true, fact: true, factDisposition: true, codeDoc: true },
    gateReceipts: [],
  };
}

function firstRound() {
  const created = applyTransition(emptyTaskLifecycleSnapshot(), create(), createProof());
  const started = applyTransition(created.snapshot, start(2), startProof());
  const submitted = applyTransition(started.snapshot, submit(3), submitProof());
  const forwarded = applyTransition(submitted.snapshot, adjudicate(4), adjudicateProof());
  const approved = applyTransition(forwarded.snapshot, review(5), reviewProof());
  const recorded = approved.snapshot.reviews[0];
  const consented = applyTransition(approved.snapshot, consent(6, recorded), consentProof());
  return { created, started, submitted, forwarded, approved, recorded, consented };
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
  // A cut awaiting the owner's triage is not blockable: the corridor (adjudicate or cancel)
  // owns every exit, so blocked->active can never skip the audited return order.
  assert.throws(
    () => applyTransition(submitted.snapshot, transition(4, "blocked"), {}),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  assert.throws(
    () => applyTransition(submitted.snapshot, transition(4, "active"), {}),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
});

test("G10 submit atomically finalizes Execution, releases lease, and lands the cut in submitted", () => {
  const { started } = firstRound();
  const result = applyTransition(started.snapshot, submit(3), submitProof());
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
      packet: submission(),
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
    const packet = submission();
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
  const { forwarded, approved, recorded } = firstRound();
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
    forwarded.snapshot,
    review(5, { actor: executor }),
    reviewProof(executor),
  );
  assert.deepEqual(transportBoundReview.snapshot.reviews[0].actor, executor);
  assert.throws(
    () => applyTransition(forwarded.snapshot, review(5, { actor: executor }), reviewProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
  // No review may be recorded before the owner's forward: the CEO gate, not the reviewer,
  // decides when a submitted cut enters independent review.
  assert.throws(
    () => applyTransition(firstRound().submitted.snapshot, review(4), reviewProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  const dismissed = applyTransition(
    approved.snapshot,
    review(6, { verdict: "dismissed", reviewId: "review-dismissed" }),
    reviewProof(),
  );
  const selected = applyTransition(dismissed.snapshot, review(7, { reviewId: "review-selected" }), reviewProof());
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
    () => applyTransition(selected.snapshot, review(8, { reviewId: "review-selected" }), reviewProof()),
    /new review id/u,
  );
  assert.throws(
    () => applyTransition(selected.snapshot, complete(8), completeProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  assert.throws(
    () =>
      applyTransition(
        { ...selected.snapshot, legacyReviewPath: "tasks/task-1/review.md" },
        complete(8),
        completeProof(),
      ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );

  const consented = applyTransition(selected.snapshot, consent(8, selectedReview), consentProof());
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
    const bad = { ...consent(8, selectedReview), ...mutation };
    assert.throws(() => applyTransition(selected.snapshot, bad, consentProof()), TaskLifecycleContractError);
  }
  const transportBound = applyTransition(
    selected.snapshot,
    consent(8, selectedReview, outsider),
    consentProof(outsider),
  );
  assert.deepEqual(transportBound.snapshot.consents[0].actor, outsider);
  assert.throws(
    () => applyTransition(selected.snapshot, consent(8, selectedReview, outsider), consentProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
  assert.equal(applyTransition(consented.snapshot, complete(9), completeProof()).snapshot.task.status, "done");
});

test("G10 code-doc witness binds canonical paths, execution, full commit, and iteration", () => {
  const { submitted, forwarded } = firstRound();
  const result = applyTransition(forwarded.snapshot, reconcile(5), reconcileProof());
  assert.deepEqual(result.snapshot.codeDocWitnesses, [
    {
      schema: "code-doc-witness/v1",
      witnessId: "witness-5",
      taskId: "task-1",
      executionId: "execution-0",
      commitSha: commit0,
      iteration: 0,
      paths: ["packages/kernel/src/domain/task.ts"],
      actor: executor,
      source: "local",
      reconciledAt: "2026-08-11T00:00:05.000Z",
    },
  ]);
  // Evidence preparation rides with the worker: the witness binds while the cut awaits
  // triage (submitted) as well as at the review gate (in_review).
  assert.notEqual(
    applyTransition(submitted.snapshot, reconcile(4), reconcileProof()).snapshot.codeDocWitnesses.length,
    0,
  );
  for (const invalid of [
    reconcile(5, "execution-0", commit1),
    reconcile(5, "execution-0", commit0, 1),
    reconcile(5, "execution-0", commit0, 0, ["../escape.md"]),
    reconcile(5, "execution-0", commit0, 0, ["same.md", "same.md"]),
  ])
    assert.throws(() => applyTransition(forwarded.snapshot, invalid, reconcileProof()), TaskLifecycleContractError);
});

test("G10 exhaustive phase table rejects every command outside its canonical predecessor", () => {
  const round = firstRound();
  const changesRequested = applyTransition(
    round.forwarded.snapshot,
    review(5, { verdict: "changes_requested", reviewId: "review-reject" }),
    reviewProof(),
  );
  const returned = applyTransition(
    changesRequested.snapshot,
    adjudicate(6, "return", "Owner accepted the report; rework the cut", "review-reject"),
    adjudicateProof(),
  );
  const completed = applyTransition(round.consented.snapshot, complete(7), completeProof());
  const states = [
    ["missing", emptyTaskLifecycleSnapshot(), new Set(["CreateReplayTask"])],
    ["planned", round.created.snapshot, new Set(["StartExecution", "TransitionTask"])],
    ["active", round.started.snapshot, new Set(["SubmitExecution", "TransitionTask"])],
    ["submitted", round.submitted.snapshot, new Set(["AdjudicateSubmission", "ReconcileCodeDoc", "TransitionTask"])],
    [
      "forwarded",
      round.forwarded.snapshot,
      new Set(["AdjudicateSubmission", "RecordReview", "ReconcileCodeDoc", "TransitionTask"]),
    ],
    [
      "approved",
      round.approved.snapshot,
      new Set(["AdjudicateSubmission", "RecordReview", "RecordReviewConsent", "ReconcileCodeDoc", "TransitionTask"]),
    ],
    [
      "consented",
      round.consented.snapshot,
      new Set([
        "AdjudicateSubmission",
        "RecordReview",
        "RecordReviewConsent",
        "ReconcileCodeDoc",
        "CompleteTask",
        "TransitionTask",
      ]),
    ],
    [
      "changes_requested at the gate",
      changesRequested.snapshot,
      new Set(["AdjudicateSubmission", "RecordReview", "RecordReviewConsent", "ReconcileCodeDoc", "TransitionTask"]),
    ],
    ["returned", returned.snapshot, new Set(["StartExecution", "TransitionTask"])],
    ["done", completed.snapshot, new Set()],
  ];
  const types = [
    "CreateReplayTask",
    "StartExecution",
    "TransitionTask",
    "SubmitExecution",
    "AdjudicateSubmission",
    "RecordReview",
    "RecordReviewConsent",
    "ReconcileCodeDoc",
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
        AdjudicateSubmission: [adjudicate(revision), adjudicateProof()],
        RecordReview: [review(revision), reviewProof()],
        RecordReviewConsent: [consent(revision, recorded), consentProof()],
        ReconcileCodeDoc: [reconcile(revision), reconcileProof()],
        CompleteTask: [complete(revision), completeProof()],
      };
      assert.throws(
        () => applyTransition(snapshot, ...entries[type]),
        TaskLifecycleContractError,
        `${label} -> ${type}`,
      );
    }
});

test("G10 the owner's adjudication is the only authority over a submitted cut", () => {
  const { submitted, forwarded } = firstRound();
  // Forward is idempotent-refused once the cut already passed the gate.
  assert.throws(
    () => applyTransition(forwarded.snapshot, adjudicate(5), adjudicateProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
  // A non-owner principal cannot adjudicate in either direction (权责红线: reviewers report,
  // owners command).
  for (const actor of [reviewer, outsider])
    assert.throws(
      () => applyTransition(submitted.snapshot, adjudicate(4), adjudicateProof(actor)),
      (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
      `non-owner ${actor.principal.personId} must not adjudicate`,
    );
  // An empty note is not an auditable order.
  assert.throws(
    () => applyTransition(submitted.snapshot, adjudicate(4, "forward", ""), adjudicateProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "missing_field",
  );
  // A verdict return must name a recorded review of this cut.
  assert.throws(
    () => applyTransition(forwarded.snapshot, adjudicate(5, "return", "rework", "review-unknown"), adjudicateProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof",
  );
  // A return order closes the cut and reopens the implementation iteration.
  const returned = applyTransition(
    submitted.snapshot,
    adjudicate(4, "return", "Owner returns the cut before review"),
    adjudicateProof(),
  );
  assert.deepEqual(
    {
      status: returned.snapshot.task.status,
      node: returned.snapshot.task.currentNode,
      iteration: returned.snapshot.task.iteration,
      execution: returned.snapshot.executions[0].state,
      closedAt: returned.snapshot.executions[0].closedAt,
      lease: returned.snapshot.lease,
    },
    {
      status: "active",
      node: "implementation",
      iteration: 1,
      execution: "changes_requested",
      closedAt: returned.event.occurredAt,
      lease: null,
    },
  );
});

test("G34 replay preserves report-to-owner-return to new execution to approved consent to complete", () => {
  const round = firstRound();
  const reported = applyTransition(
    round.forwarded.snapshot,
    review(5, { verdict: "changes_requested", reviewId: "review-reject" }),
    reviewProof(),
  );
  // The reviewer's verdict reports; the cut stays at the gate until the owner's return order.
  assert.deepEqual(
    {
      status: reported.snapshot.task.status,
      node: reported.snapshot.task.currentNode,
      iteration: reported.snapshot.task.iteration,
      execution: reported.snapshot.executions[0].state,
      lease: reported.snapshot.lease,
    },
    { status: "in_review", node: "review", iteration: 0, execution: "submitted", lease: null },
  );
  const rejected = applyTransition(
    reported.snapshot,
    adjudicate(6, "return", "Owner accepted the report; rework the cut", "review-reject"),
    adjudicateProof(),
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
  const startedAgain = applyTransition(rejected.snapshot, start(7, "execution-1"), startProof("execution-1"));
  const submittedAgain = applyTransition(startedAgain.snapshot, submit(8, "execution-1", commit1), submitProof());
  const forwardedAgain = applyTransition(
    submittedAgain.snapshot,
    command(
      owner,
      9,
      {
        type: "AdjudicateSubmission",
        taskId: "task-1",
        executionId: "execution-1",
        decision: "forward",
        reason: "Second cut forwarded",
      },
      "adjudicate-forward-2",
    ),
    adjudicateProof(),
  );
  const approvedAgain = applyTransition(
    forwardedAgain.snapshot,
    review(10, { executionId: "execution-1", commitSha: commit1, iteration: 1, reviewId: "review-execution-1" }),
    reviewProof(),
  );
  const recorded = approvedAgain.snapshot.reviews.at(-1);
  const consentedAgain = applyTransition(approvedAgain.snapshot, consent(11, recorded), consentProof());
  const completed = applyTransition(consentedAgain.snapshot, complete(12, "execution-1"), completeProof());
  const events = [
    round.created.event,
    round.started.event,
    round.submitted.event,
    round.forwarded.event,
    reported.event,
    rejected.event,
    startedAgain.event,
    submittedAgain.event,
    forwardedAgain.event,
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
  // A second-round review cannot land before the owner forwards that cut either: the CEO
  // gate is structural, not a per-round courtesy (the reviewer return budget this assertion
  // used to pin is deleted — every return now carries the owner's auditable order).
  assert.throws(
    () =>
      applyTransition(
        submittedAgain.snapshot,
        review(9, {
          verdict: "changes_requested",
          executionId: "execution-1",
          commitSha: commit1,
          iteration: 1,
          reviewId: "review-second-reject",
        }),
        reviewProof(),
      ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition",
  );
});
