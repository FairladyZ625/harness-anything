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
  TaskLifecycleContractError
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../../packages/kernel/src/domain/task-graph.ts";
import { TASK_LEASE_BROKER_CONTRACT } from "../../../packages/kernel/src/domain/execution.ts";

const owner = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "owner-agent" } };
const executor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker-agent" } };
const reviewer = { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "review-agent" } };
const outsider = { principal: { personId: "person-outsider" }, executor: null };
const commit0 = "0123456789abcdef0123456789abcdef01234567";
const commit1 = "1123456789abcdef0123456789abcdef01234567";
const content0 = `sha256:${"a".repeat(64)}`;

function command(actor, revision, intent, suffix = intent.type) {
  return {
    ...normalizeTaskLifecycleCommand({ workspaceId: "workspace-1", actor, source: "local", expectedRevision: revision - 1 }, intent),
    eventId: `evt-${suffix}-${revision}`,
    workspaceRevision: revision,
    occurredAt: `2026-08-11T00:00:${String(revision).padStart(2, "0")}.000Z`
  };
}

function create(revision = 1) { return command(owner, revision, { type: "CreateReplayTask", taskId: "task-1", title: "Replay task", taskClass: "standard", graph: REPLAY_TASK_GRAPH, completionGateIds: [], presetSnapshotDigest: null }, "create"); }
function createProof() { return { taskIdUnique: true, actorBinding: owner }; }
function start(revision, executionId = "execution-0") { return command(executor, revision, { type: "StartExecution", taskId: "task-1", executionId }, `start-${executionId}`); }
function startProof(executionId = "execution-0") { return { actorBinding: executor, reservation: { taskId: "task-1", executionId, expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000, previousHolder: null, reason: "initial_claim", version: 1 } }; }
function transition(revision, status, reason = `Transition to ${status}`, force = status === "cancelled") { return command(owner, revision, { type: "TransitionTask", taskId: "task-1", status, reason, force }, `transition-${status}`); }
function submission(commitSha = commit0) { return { completionClaim: "Implementation is ready for review.", deliverables: ["kernel lifecycle"], outputs: ["typed event"], verificationNotes: ["contract tests"], knownGaps: [], residualRisks: [], commitSha }; }
function submit(revision, executionId = "execution-0", commitSha = commit0) { return command(executor, revision, { type: "SubmitExecution", taskId: "task-1", executionId, submission: submission(commitSha) }, `submit-${executionId}`); }
function submitProof() { return { actorBinding: executor, leaseVersion: 1, sessionDisposition: "complete" }; }
function review(revision, { verdict = "approved", executionId = "execution-0", commitSha = commit0, iteration = 0, actor = reviewer, reviewId = `review-${executionId}`, contentDigest = content0 } = {}) { return command(actor, revision, { type: "RecordReview", taskId: "task-1", executionId, reviewId, verdict, reason: verdict === "changes_requested" ? "A concrete correction is required." : "The submitted content cut is approved.", evidenceChecked: ["tests"], commitSha, iteration, contentDigest }, `${reviewId}-${verdict}`); }
function reviewProof(actor = reviewer) { return { actorBinding: actor, capability: "execution-review@v1", capabilityRef: "capability:review" }; }
function consent(revision, recorded, actor = owner) { return command(actor, revision, { type: "RecordReviewConsent", taskId: "task-1", executionId: recorded.executionId, reviewId: recorded.reviewId, consentId: `consent-${recorded.reviewId}`, reviewDigest: reviewDigest(recorded), contentDigest: recorded.contentDigest }, `consent-${recorded.reviewId}`); }
function consentProof(actor = owner) { return { actorBinding: actor, capability: "execution-consent@v1", capabilityRef: "capability:owner-consent" }; }
function reconcile(revision, executionId = "execution-0", commitSha = commit0, iteration = 0, paths = ["packages/kernel/src/domain/task.ts"]) { return command(executor, revision, { type: "ReconcileCodeDoc", taskId: "task-1", executionId, witnessId: `witness-${revision}`, commitSha, iteration, paths }, `reconcile-${revision}`); }
function reconcileProof() { return { actorBinding: executor, capability: "code-doc-reconcile@v1", capabilityRef: "capability:code-doc" }; }
function complete(revision, executionId = "execution-0") { return command(owner, revision, { type: "CompleteTask", taskId: "task-1", executionId }, `complete-${executionId}`); }
function completeProof() { return { capability: "task-complete@v1", capabilityRef: "capability:complete", actorRole: "owner", noActiveLease: true, gateReceipts: [] }; }

function firstRound() {
  const created = applyTransition(emptyTaskLifecycleSnapshot(), create(), createProof());
  const started = applyTransition(created.snapshot, start(2), startProof());
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
  assert.deepEqual(blocked.event.payload.mutation, { command: "transition", reason: "Transition to blocked", fields: ["status"] });
  assert.deepEqual(reduceTaskEvent(created.snapshot, blocked.event), blocked.snapshot, "the unchanged task_transitioned event shape must replay exactly");
  assert.equal(applyTransition(created.snapshot, transition(2, "blocked", "Force remains an ignored block flag", true), {}).snapshot.task.status, "blocked");
  const unblocked = applyTransition(blocked.snapshot, transition(3, "active"), {});
  assert.equal(unblocked.snapshot.task.status, "active");
  assert.deepEqual(unblocked.event.payload.mutation, { command: "transition", reason: "Transition to active", fields: ["status"] });
  assert.deepEqual(reduceTaskEvent(blocked.snapshot, unblocked.event), unblocked.snapshot);
  assert.throws(() => applyTransition(created.snapshot, transition(2, "active"), {}), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition");

  const cancelled = applyTransition(blocked.snapshot, transition(3, "cancelled", "Scope was withdrawn", true), {});
  assert.equal(cancelled.snapshot.task.status, "cancelled");
  assert.deepEqual(reduceTaskEvent(blocked.snapshot, cancelled.event), cancelled.snapshot);
  assert.throws(() => applyTransition(blocked.snapshot, transition(3, "cancelled", "", false), {}), /force and an auditable reason/u);

  const started = applyTransition(created.snapshot, start(2), startProof());
  assert.throws(() => applyTransition(started.snapshot, transition(3, "blocked"), {}), /unleased/u);
  const { submitted } = firstRound();
  assert.equal(applyTransition(submitted.snapshot, transition(4, "blocked"), {}).snapshot.task.status, "blocked");
  assert.throws(() => applyTransition(submitted.snapshot, transition(4, "active"), {}), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition");
});

test("G10 submit atomically finalizes Execution, releases lease, and enters in_review", () => {
  const { started } = firstRound();
  const result = applyTransition(started.snapshot, submit(3), submitProof());
  assert.deepEqual({ execution: result.snapshot.executions[0].state, packet: result.snapshot.executions[0].submission, lease: result.snapshot.lease, status: result.snapshot.task.status, node: result.snapshot.task.currentNode, edge: result.snapshot.edgesTaken[0].edgeId }, { execution: "submitted", packet: submission(), lease: null, status: "in_review", node: "review", edge: "implementation-submitted" });
  assert.deepEqual(result.event.payload.execution, result.snapshot.executions[0]);

  for (const field of ["completionClaim", "deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks", "commitSha"]) {
    const packet = submission(); delete packet[field];
    const before = structuredClone(started.snapshot);
    assert.throws(() => applyTransition(started.snapshot, command(executor, 3, { type: "SubmitExecution", taskId: "task-1", executionId: "execution-0", submission: packet }, `missing-${field}`), submitProof()), TaskLifecycleContractError, field);
    assert.deepEqual(started.snapshot, before, `${field} must be zero-write`);
  }
  assert.throws(() => applyTransition(started.snapshot, submit(3), { ...submitProof(), leaseVersion: 2 }), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof");
});

test("G10 one immutable Review and independent content-pinned consent authorize completion", () => {
  const { submitted, approved, recorded, consented } = firstRound();
  assert.equal(approved.snapshot.reviews.length, 1);
  assert.equal(approved.snapshot.consents.length, 0);
  assert.deepEqual({ executionId: recorded.executionId, commitSha: recorded.commitSha, iteration: recorded.iteration, contentDigest: recorded.contentDigest, actor: recorded.actor }, { executionId: "execution-0", commitSha: commit0, iteration: 0, contentDigest: content0, actor: reviewer });
  assert.throws(() => applyTransition(submitted.snapshot, review(4, { actor: executor }), reviewProof(executor)), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof");
  assert.throws(() => applyTransition(approved.snapshot, review(5, { reviewId: "review-second" }), reviewProof()), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition");
  assert.throws(() => applyTransition(approved.snapshot, complete(5), completeProof()), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition");
  assert.throws(() => applyTransition({ ...approved.snapshot, legacyReviewPath: "tasks/task-1/review.md" }, complete(5), completeProof()), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition");

  const pinned = consented.snapshot.consents[0];
  assert.deepEqual({ executionId: pinned.executionId, reviewId: pinned.reviewId, reviewDigest: pinned.reviewDigest, contentDigest: pinned.contentDigest, actor: pinned.actor, source: pinned.source }, { executionId: recorded.executionId, reviewId: recorded.reviewId, reviewDigest: reviewDigest(recorded), contentDigest: recorded.contentDigest, actor: owner, source: "local" });
  for (const mutation of [
    { reviewDigest: `sha256:${"b".repeat(64)}` },
    { contentDigest: `sha256:${"c".repeat(64)}` },
    { executionId: "execution-other" },
    { reviewId: "review-other" }
  ]) {
    const bad = { ...consent(5, recorded), ...mutation };
    assert.throws(() => applyTransition(approved.snapshot, bad, consentProof()), TaskLifecycleContractError);
  }
  assert.throws(() => applyTransition(approved.snapshot, consent(5, recorded, outsider), consentProof(outsider)), (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof");
  assert.equal(applyTransition(consented.snapshot, complete(6), completeProof()).snapshot.task.status, "done");
});

test("G10 code-doc witness binds canonical paths, execution, full commit, and iteration", () => {
  const { submitted } = firstRound();
  const result = applyTransition(submitted.snapshot, reconcile(4), reconcileProof());
  assert.deepEqual(result.snapshot.codeDocWitnesses, [{ schema: "code-doc-witness/v1", witnessId: "witness-4", taskId: "task-1", executionId: "execution-0", commitSha: commit0, iteration: 0, paths: ["packages/kernel/src/domain/task.ts"], actor: executor, source: "local", reconciledAt: "2026-08-11T00:00:04.000Z" }]);
  for (const invalid of [
    reconcile(4, "execution-0", commit1),
    reconcile(4, "execution-0", commit0, 1),
    reconcile(4, "execution-0", commit0, 0, ["../escape.md"]),
    reconcile(4, "execution-0", commit0, 0, ["same.md", "same.md"])
  ]) assert.throws(() => applyTransition(submitted.snapshot, invalid, reconcileProof()), TaskLifecycleContractError);
});

test("G10 exhaustive phase table rejects every command outside its canonical predecessor", () => {
  const round = firstRound();
  const returned = applyTransition(round.submitted.snapshot, review(4, { verdict: "changes_requested", reviewId: "review-reject" }), reviewProof());
  const completed = applyTransition(round.consented.snapshot, complete(6), completeProof());
  const states = [
    ["missing", emptyTaskLifecycleSnapshot(), new Set(["CreateReplayTask"])],
    ["planned", round.created.snapshot, new Set(["StartExecution", "TransitionTask"])],
    ["active", round.started.snapshot, new Set(["SubmitExecution"])],
    ["submitted", round.submitted.snapshot, new Set(["RecordReview", "ReconcileCodeDoc", "TransitionTask"])],
    ["approved", round.approved.snapshot, new Set(["RecordReviewConsent", "ReconcileCodeDoc", "TransitionTask"])],
    ["consented", round.consented.snapshot, new Set(["ReconcileCodeDoc", "CompleteTask", "TransitionTask"])],
    ["returned", returned.snapshot, new Set(["StartExecution", "TransitionTask"])],
    ["done", completed.snapshot, new Set()]
  ];
  const types = ["CreateReplayTask", "StartExecution", "TransitionTask", "SubmitExecution", "RecordReview", "RecordReviewConsent", "ReconcileCodeDoc", "CompleteTask"];
  for (const [label, snapshot, allowed] of states) for (const type of types) {
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
      ReconcileCodeDoc: [reconcile(revision), reconcileProof()],
      CompleteTask: [complete(revision), completeProof()]
    };
    assert.throws(() => applyTransition(snapshot, ...entries[type]), TaskLifecycleContractError, `${label} -> ${type}`);
  }
});

test("G34 replay preserves reject to new execution to approved consent to complete", () => {
  const round = firstRound();
  const rejected = applyTransition(round.submitted.snapshot, review(4, { verdict: "changes_requested", reviewId: "review-reject" }), reviewProof());
  assert.deepEqual({ status: rejected.snapshot.task.status, node: rejected.snapshot.task.currentNode, iteration: rejected.snapshot.task.iteration, execution: rejected.snapshot.executions[0].state, lease: rejected.snapshot.lease }, { status: "active", node: "implementation", iteration: 1, execution: "changes_requested", lease: null });
  const startedAgain = applyTransition(rejected.snapshot, start(5, "execution-1"), startProof("execution-1"));
  const submittedAgain = applyTransition(startedAgain.snapshot, submit(6, "execution-1", commit1), submitProof());
  const approvedAgain = applyTransition(submittedAgain.snapshot, review(7, { executionId: "execution-1", commitSha: commit1, iteration: 1, reviewId: "review-execution-1" }), reviewProof());
  const recorded = approvedAgain.snapshot.reviews.at(-1);
  const consentedAgain = applyTransition(approvedAgain.snapshot, consent(8, recorded), consentProof());
  const completed = applyTransition(consentedAgain.snapshot, complete(9, "execution-1"), completeProof());
  const events = [round.created.event, round.started.event, round.submitted.event, rejected.event, startedAgain.event, submittedAgain.event, approvedAgain.event, consentedAgain.event, completed.event];
  let replayed = emptyTaskLifecycleSnapshot();
  for (const event of events) { assert.doesNotThrow(() => serializeTaskEvent(event)); replayed = reduceTaskEvent(replayed, event); }
  assert.deepEqual(replayed, completed.snapshot);
  assert.equal(replayed.task.status, "done");
  assert.equal(replayed.executions[1].state, "accepted");
  assert.throws(() => applyTransition(submittedAgain.snapshot, review(7, { verdict: "changes_requested", executionId: "execution-1", commitSha: commit1, iteration: 1, reviewId: "review-second-reject" }), reviewProof()), (error) => error instanceof TaskLifecycleContractError && error.code === "manual_intervention_required");
});
