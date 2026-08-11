// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTransition,
  assertAntiEntropyGraph,
  emptyTaskLifecycleSnapshot,
  reduceTaskEvent,
  serializeTaskEvent,
  TaskLifecycleContractError
} from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { REPLAY_TASK_GRAPH } from "../../../packages/kernel/src/domain/task-graph.ts";
import { TASK_LEASE_BROKER_CONTRACT } from "../../../packages/kernel/src/domain/execution.ts";

const owner = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "owner-agent" } };
const executor = { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "worker-agent" } };
const antiEntropy = { principal: { personId: "person-reviewer" }, executor: { kind: "agent", id: "anti-entropy-agent" } };
const acceptance = { principal: { personId: "person-acceptance" }, executor: null };
const commit0 = "0123456789abcdef0123456789abcdef01234567";

test("G10 Lease broker contract declares one positive capacity ceiling", () => {
  assert.deepEqual(TASK_LEASE_BROKER_CONTRACT, { capacity: 32 });
  assert.equal(Object.isFrozen(TASK_LEASE_BROKER_CONTRACT), true);
});

function meta(type, actor, revision, suffix = type) {
  return {
    type,
    taskId: "task-1",
    actor,
    opId: `op-${suffix}`,
    eventId: `evt-${suffix}`,
    workspaceRevision: revision,
    occurredAt: `2026-08-11T00:00:0${revision}.000Z`
  };
}

function createCommand() {
  return {
    ...meta("CreateReplayTask", owner, 1, "create"),
    title: "Replay task",
    graph: REPLAY_TASK_GRAPH,
    completionGateIds: []
  };
}

function createProof() {
  return { taskIdUnique: true, actorBinding: owner };
}

function createdSnapshot() {
  return applyTransition(emptyTaskLifecycleSnapshot(), createCommand(), createProof()).snapshot;
}

function startCommand(revision = 2, executionId = "execution-0") {
  return { ...meta("StartExecution", executor, revision, `start-${executionId}`), executionId };
}

function startProof(revision = 1, executionId = "execution-0") {
  return {
    actorBinding: executor,
    expectedRevision: revision,
    reservation: {
      taskId: "task-1",
      executionId,
      credentialHash: "sha256:lease-0",
      expiresAt: "2026-08-11T01:00:00.000Z",
      version: 1
    }
  };
}

function startedSnapshot() {
  return applyTransition(createdSnapshot(), startCommand(), startProof()).snapshot;
}

function submission(commitSha = commit0) {
  return {
    claim: "Implementation is ready for adversarial review.",
    deliverables: ["packages/kernel/src/domain"],
    evidenceRefs: [],
    verification: ["contract tests"],
    knownGaps: [],
    residualRisks: [],
    commitSha
  };
}

function submitCommand(revision = 3, commitSha = commit0) {
  return submitRoundCommand(revision, "execution-0", commitSha);
}

function submitProof(credentialHash = "sha256:lease-0") {
  return submitRoundProof(2, credentialHash);
}

function submitRoundCommand(revision, executionId, commitSha) {
  return { ...meta("SubmitExecution", executor, revision, `submit-${executionId}`), executionId, submission: submission(commitSha) };
}

function submitRoundProof(expectedRevision, credentialHash = "sha256:lease-0") {
  return { expectedRevision, credentialHash, sessionDisposition: "complete" };
}

function submittedSnapshot() {
  return applyTransition(startedSnapshot(), submitCommand(), submitProof()).snapshot;
}

function reviewCommand({ kind = "anti_entropy", verdict = "approved", actor = antiEntropy, actorRole = kind, revision = 4, iteration = 0, commitSha = commit0, suffix = `${kind}-${verdict}-${iteration}` } = {}) {
  return {
    ...meta("RecordReview", actor, revision, suffix),
    executionId: `execution-${iteration}`,
    reviewId: `review-${suffix}`,
    kind,
    verdict,
    actorRole,
    reason: verdict === "changes_requested" ? "A concrete correction is required." : "The submitted implementation matches the contract.",
    evidenceChecked: [],
    commitSha,
    iteration,
    archiveWarningsAcknowledged: false
  };
}

function reviewProof({ kind = "anti_entropy", revision = 3, actor = antiEntropy, archiveWarningsPresent = false } = {}) {
  return {
    expectedRevision: revision,
    actorBinding: actor,
    capability: kind === "anti_entropy" ? "anti-entropy@v1" : "acceptance-review@v1",
    capabilityRef: `capability:${kind}`,
    archiveWarningsPresent
  };
}

function antiEntropyApprovedSnapshot() {
  return applyTransition(submittedSnapshot(), reviewCommand(), reviewProof()).snapshot;
}

function acceptanceApprovedSnapshot() {
  return applyTransition(
    antiEntropyApprovedSnapshot(),
    reviewCommand({ kind: "acceptance", actor: acceptance, actorRole: "acceptance", revision: 5, suffix: "acceptance-approved" }),
    reviewProof({ kind: "acceptance", revision: 4, actor: acceptance })
  ).snapshot;
}

function completeCommand(revision = 6) {
  return { ...meta("CompleteTask", owner, revision, "complete"), executionId: "execution-0" };
}

function completeProof(expectedRevision = 5) {
  return {
    expectedRevision,
    capability: "task-complete@v1",
    capabilityRef: "capability:task-complete",
    actorRole: "owner",
    noActiveLease: true,
    gateReceipts: []
  };
}

test("G10 CreateReplayTask moves only a missing aggregate to planned/implementation/0", () => {
  const created = applyTransition(emptyTaskLifecycleSnapshot(), createCommand(), createProof());
  assert.equal(created.event.type, "task_created");
  assert.deepEqual(
    { status: created.snapshot.task.status, node: created.snapshot.task.currentNode, iteration: created.snapshot.task.iteration },
    { status: "planned", node: "implementation", iteration: 0 }
  );
  assert.throws(
    () => applyTransition(created.snapshot, { ...createCommand(), workspaceRevision: 2 }, createProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
});

test("G10 StartExecution atomically activates one execution and its lease", () => {
  const started = applyTransition(createdSnapshot(), startCommand(), startProof());
  assert.equal(started.event.type, "execution_started");
  assert.equal(started.snapshot.task.status, "active");
  assert.equal(started.snapshot.executions[0].state, "active");
  assert.equal(started.snapshot.lease.phase, "active");
  assert.throws(
    () => applyTransition(started.snapshot, startCommand(3, "execution-other"), startProof(2, "execution-other")),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
});

test("G10 SubmitExecution submits the execution, releases its exact lease, and advances one edge", () => {
  const submitted = applyTransition(startedSnapshot(), submitCommand(), submitProof());
  assert.equal(submitted.event.type, "execution_submitted");
  assert.equal(submitted.snapshot.executions[0].state, "submitted");
  assert.equal(submitted.snapshot.lease, null);
  assert.equal(submitted.snapshot.task.currentNode, "anti_entropy");
  assert.equal(submitted.snapshot.edgesTaken[0].edgeId, "implementation-submitted");
  assert.throws(
    () => applyTransition(startedSnapshot(), submitCommand(), submitProof("sha256:not-the-holder")),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
});

test("G10 anti-entropy approval advances only to in_review/review", () => {
  const reviewed = applyTransition(submittedSnapshot(), reviewCommand(), reviewProof());
  assert.equal(reviewed.event.type, "review_recorded");
  assert.deepEqual(
    { status: reviewed.snapshot.task.status, node: reviewed.snapshot.task.currentNode, execution: reviewed.snapshot.executions[0].state },
    { status: "in_review", node: "review", execution: "submitted" }
  );
  assert.equal(reviewed.snapshot.edgesTaken[1].edgeId, "anti-entropy-approved");
  assert.throws(
    () => applyTransition(startedSnapshot(), reviewCommand({ revision: 3 }), reviewProof({ revision: 2 })),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
});

test("G10 anti-entropy changes_requested consumes the sole return budget", () => {
  const rejected = applyTransition(
    submittedSnapshot(),
    reviewCommand({ verdict: "changes_requested", suffix: "reject-0" }),
    reviewProof()
  );
  assert.deepEqual(
    { status: rejected.snapshot.task.status, node: rejected.snapshot.task.currentNode, iteration: rejected.snapshot.task.iteration },
    { status: "active", node: "implementation", iteration: 1 }
  );
  assert.equal(rejected.snapshot.executions[0].state, "changes_requested");
  assert.equal(rejected.snapshot.lease, null);
  assert.equal(rejected.snapshot.edgesTaken[1].edgeId, "anti-entropy-changes-requested");

  const startedAgain = applyTransition(rejected.snapshot, startCommand(5, "execution-1"), startProof(4, "execution-1"));
  const submittedAgain = applyTransition(
    startedAgain.snapshot,
    submitRoundCommand(6, "execution-1", "1123456789abcdef0123456789abcdef01234567"),
    submitRoundProof(5)
  );
  assert.throws(
    () => applyTransition(
      submittedAgain.snapshot,
      reviewCommand({ verdict: "changes_requested", revision: 7, iteration: 1, commitSha: "1123456789abcdef0123456789abcdef01234567", suffix: "reject-1" }),
      reviewProof({ revision: 6 })
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "manual_intervention_required"
  );
});

test("G10 dismissed review is immutable but does not advance its node", () => {
  const dismissed = applyTransition(
    submittedSnapshot(),
    reviewCommand({ verdict: "dismissed", suffix: "dismiss-anti" }),
    reviewProof()
  );
  assert.equal(dismissed.snapshot.task.currentNode, "anti_entropy");
  assert.equal(dismissed.snapshot.task.status, "active");
  assert.equal(dismissed.snapshot.reviews[0].verdict, "dismissed");
  assert.equal(dismissed.snapshot.edgesTaken.length, 1);
  assert.throws(
    () => applyTransition(
      submittedSnapshot(),
      reviewCommand({ kind: "acceptance", verdict: "dismissed", actor: acceptance, actorRole: "acceptance", suffix: "dismiss-wrong-node" }),
      reviewProof({ kind: "acceptance", actor: acceptance })
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
});

test("G10 acceptance approval marks the same round ready without completing it", () => {
  const command = reviewCommand({ kind: "acceptance", actor: acceptance, actorRole: "acceptance", revision: 5, suffix: "acceptance-approved" });
  const proof = reviewProof({ kind: "acceptance", revision: 4, actor: acceptance });
  const acceptedReview = applyTransition(antiEntropyApprovedSnapshot(), command, proof);
  assert.equal(acceptedReview.snapshot.task.status, "in_review");
  assert.equal(acceptedReview.snapshot.executions[0].state, "submitted");
  assert.equal(acceptedReview.snapshot.reviews.at(-1).kind, "acceptance");
  assert.equal(acceptedReview.snapshot.edgesTaken.length, 2);
  assert.throws(
    () => applyTransition(
      antiEntropyApprovedSnapshot(),
      command,
      { ...proof, archiveWarningsPresent: true }
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
});

test("G10 CompleteTask consumes both same-round approvals and alone marks done", () => {
  const completed = applyTransition(acceptanceApprovedSnapshot(), completeCommand(), completeProof());
  assert.equal(completed.event.type, "task_completed");
  assert.equal(completed.snapshot.task.status, "done");
  assert.equal(completed.snapshot.executions[0].state, "accepted");
  assert.throws(
    () => applyTransition(antiEntropyApprovedSnapshot(), completeCommand(5), completeProof(4)),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
  assert.throws(
    () => applyTransition(completed.snapshot, startCommand(7, "execution-terminal"), startProof(6, "execution-terminal")),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
  const ready = acceptanceApprovedSnapshot();
  const gated = { ...ready, task: { ...ready.task, completionGateIds: ["G-test"] } };
  assert.throws(
    () => applyTransition(gated, completeCommand(), completeProof()),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
  assert.equal(applyTransition(gated, completeCommand(), {
    ...completeProof(),
    gateReceipts: [{ gateId: "G-test", receiptRef: "artifacts/g-test.json", result: "pass", executionId: "execution-0", commitSha: commit0, iteration: 0 }]
  }).snapshot.task.status, "done");
});

test("G34 rejects an ordinary role attempting the anti-entropy return edge", () => {
  assert.throws(
    () => assertAntiEntropyGraph(
      submittedSnapshot(),
      reviewCommand({ verdict: "changes_requested", actorRole: "acceptance", suffix: "ordinary-reject" }),
      reviewProof()
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
});

test("G34 rejects return-edge commands missing reason, commitSha, or iteration", () => {
  const valid = reviewCommand({ verdict: "changes_requested", suffix: "missing-field" });
  for (const field of ["reason", "commitSha", "iteration"]) {
    const incomplete = { ...valid };
    delete incomplete[field];
    assert.throws(
      () => assertAntiEntropyGraph(submittedSnapshot(), incomplete, reviewProof()),
      (error) => error instanceof TaskLifecycleContractError,
      field
    );
  }
});

test("G34 rejects review evidence bound to a stale commit SHA", () => {
  assert.throws(
    () => assertAntiEntropyGraph(
      submittedSnapshot(),
      reviewCommand({ verdict: "changes_requested", commitSha: "2123456789abcdef0123456789abcdef01234567", suffix: "stale-sha" }),
      reviewProof()
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
});

test("G34 rejects self-review by the implementation executor", () => {
  assert.throws(
    () => assertAntiEntropyGraph(
      submittedSnapshot(),
      reviewCommand({ verdict: "changes_requested", actor: executor, suffix: "self-review" }),
      reviewProof({ actor: executor })
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
});

test("G34 rejects iteration=2 rather than silently extending the budget", () => {
  assert.throws(
    () => assertAntiEntropyGraph(
      submittedSnapshot(),
      { ...reviewCommand({ verdict: "changes_requested", iteration: 2, suffix: "iteration-2" }), executionId: "execution-0" },
      reviewProof()
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_proof"
  );
});

test("G34 rejects metadata-shaped attempts to create a return edge", () => {
  assert.throws(
    () => assertAntiEntropyGraph(
      submittedSnapshot(),
      { ...meta("UpdateTaskMetadata", antiEntropy, 4, "metadata-return"), status: "active", currentNode: "implementation", iteration: 1 },
      reviewProof()
    ),
    (error) => error instanceof TaskLifecycleContractError && error.code === "invalid_transition"
  );
});

test("G34 anti-entropy approve cannot mark Task done or Execution accepted", () => {
  assert.doesNotThrow(() => assertAntiEntropyGraph(submittedSnapshot(), reviewCommand(), reviewProof()));
  const reviewed = applyTransition(submittedSnapshot(), reviewCommand(), reviewProof());
  assert.notEqual(reviewed.snapshot.task.status, "done");
  assert.notEqual(reviewed.snapshot.executions[0].state, "accepted");
});

test("G34 replays reject to new execution to both approvals to complete", () => {
  const commit1 = "1123456789abcdef0123456789abcdef01234567";
  const rejected = applyTransition(submittedSnapshot(), reviewCommand({ verdict: "changes_requested", suffix: "chain-reject" }), reviewProof());
  const started = applyTransition(rejected.snapshot, startCommand(5, "execution-1"), startProof(4, "execution-1"));
  const submitted = applyTransition(started.snapshot, submitRoundCommand(6, "execution-1", commit1), submitRoundProof(5));
  const antiApproved = applyTransition(
    submitted.snapshot,
    reviewCommand({ revision: 7, iteration: 1, commitSha: commit1, suffix: "chain-anti-approved" }),
    reviewProof({ revision: 6 })
  );
  const acceptanceApproved = applyTransition(
    antiApproved.snapshot,
    reviewCommand({ kind: "acceptance", actor: acceptance, actorRole: "acceptance", revision: 8, iteration: 1, commitSha: commit1, suffix: "chain-acceptance-approved" }),
    reviewProof({ kind: "acceptance", revision: 7, actor: acceptance })
  );
  const completed = applyTransition(
    acceptanceApproved.snapshot,
    { ...completeCommand(9), executionId: "execution-1" },
    completeProof(8)
  );
  assert.equal(completed.snapshot.task.status, "done");
  assert.deepEqual(completed.snapshot.executions.map((execution) => execution.state), ["changes_requested", "accepted"]);
  assert.equal(completed.snapshot.edgesTaken.length, 4);
});

test("G09 projection reducer replays all five task-event/v1 envelope types", () => {
  const created = applyTransition(emptyTaskLifecycleSnapshot(), createCommand(), createProof());
  const started = applyTransition(created.snapshot, startCommand(), startProof());
  const submitted = applyTransition(started.snapshot, submitCommand(), submitProof());
  const antiApproved = applyTransition(submitted.snapshot, reviewCommand(), reviewProof());
  const acceptanceApproved = applyTransition(
    antiApproved.snapshot,
    reviewCommand({ kind: "acceptance", actor: acceptance, actorRole: "acceptance", revision: 5, suffix: "replay-acceptance" }),
    reviewProof({ kind: "acceptance", revision: 4, actor: acceptance })
  );
  const completed = applyTransition(acceptanceApproved.snapshot, completeCommand(), completeProof());
  const events = [created.event, started.event, submitted.event, antiApproved.event, acceptanceApproved.event, completed.event];
  let replayed = emptyTaskLifecycleSnapshot();
  for (const event of events) {
    assert.doesNotThrow(() => serializeTaskEvent(event));
    replayed = reduceTaskEvent(replayed, event);
  }
  assert.deepEqual([...new Set(events.map((event) => event.type))], [
    "task_created",
    "execution_started",
    "execution_submitted",
    "review_recorded",
    "task_completed"
  ]);
  assert.equal(replayed.task.status, "done");
});

export { acceptance, antiEntropy, commit0, createCommand, createProof, executor, meta, owner, reviewCommand, reviewProof, startCommand, startProof, submitCommand, submitProof };
