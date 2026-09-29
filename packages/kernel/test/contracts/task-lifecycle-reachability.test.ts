// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { submissionDigest } from "../../src/domain/execution.ts";
import { stateTransition } from "../../src/domain/task-action-state-transition.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  TASK_LIFECYCLE_TRANSITIONS,
  applyTransition,
  emptyTaskLifecycleSnapshot,
  normalizeTaskLifecycleCommand,
  reviewDigest,
  type TaskLifecycleCommand,
  type TaskLifecycleCommandIntent,
  type TaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";
import {
  evaluateTaskActionCapability,
  getTaskActionForTransition,
  taskLifecycleNextActions,
} from "../../src/domain/index.ts";
import type { ActorAxes } from "../../src/domain/task.ts";

const owner: ActorAxes = {
    principal: { personId: "person-owner" },
    executor: { kind: "agent", id: "owner-agent" },
  },
  reviewer: ActorAxes = {
    principal: { personId: "person-reviewer" },
    executor: { kind: "agent", id: "reviewer-agent" },
  },
  commitSha = "a".repeat(40),
  completionContract = { gates: [] };

function command(snapshot: TaskLifecycleSnapshot, actor: ActorAxes, intent: TaskLifecycleCommandIntent) {
  const revision = snapshot.revision + 1;
  return {
    ...normalizeTaskLifecycleCommand(
      {
        workspaceId: "workspace-1",
        actor,
        source: "local",
        expectedRevision: intent.type === "CreateReplayTask" ? 0 : snapshot.revision,
      },
      intent,
    ),
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    occurredAt: `2026-09-29T00:00:${String(revision).padStart(2, "0")}.000Z`,
  } as TaskLifecycleCommand;
}

function candidates(snapshot: TaskLifecycleSnapshot): readonly { command: TaskLifecycleCommand; proof: unknown }[] {
  const taskId = "task-reachability",
    iteration = snapshot.task?.iteration ?? 0,
    executionId = `execution-${iteration}`,
    currentExecution = snapshot.executions.find((value) => value.iteration === iteration),
    currentReview = snapshot.reviews.find((value) => value.executionId === currentExecution?.executionId),
    make = (actor: ActorAxes, intent: TaskLifecycleCommandIntent, proof: unknown) => ({
      command: command(snapshot, actor, intent),
      proof,
    }),
    transitions = (["planned", "active", "in_review", "blocked", "cancelled"] as const).map((status) =>
      make(owner, { type: "TransitionTask", taskId, status, reason: "reachability", force: true }, {}),
    ),
    start = make(
      owner,
      { type: "StartExecution", taskId, executionId },
      {
        actorBinding: owner,
        deliveryBaseline: { kind: "commit", commitSha: "0".repeat(40) },
        reservation: {
          taskId,
          executionId,
          expiresAt: "2026-09-29T01:00:00.000Z",
          ttlMs: 1_800_000,
          previousHolder: null,
          reason: "initial_claim",
          version: 0,
        },
      },
    ),
    submit = make(
      owner,
      {
        type: "SubmitExecution",
        taskId,
        executionId,
        submission: {
          completionClaim: "implemented",
          deliverables: [],
          outputs: [],
          verificationNotes: ["reachability"],
          knownGaps: [],
          residualRisks: [],
          commitSha,
          completionContract,
        },
      },
      { actorBinding: owner, leaseVersion: 0, sessionDisposition: "complete" },
    ),
    adjudications = (["forward", "return"] as const).map((decision) =>
      make(
        owner,
        { type: "AdjudicateSubmission", taskId, executionId, decision, reason: "reachability" },
        { actorBinding: owner, capability: "task-adjudicate@v1", capabilityRef: "cap-adjudicate" },
      ),
    ),
    review = make(
      reviewer,
      {
        type: "RecordReview",
        taskId,
        executionId,
        reviewId: `review-${iteration}`,
        verdict: "approved",
        reason: "approved",
        evidenceChecked: ["reachability"],
        commitSha,
        iteration,
        contentDigest: `sha256:${"b".repeat(64)}`,
        submissionDigest: currentExecution?.submission
          ? submissionDigest(currentExecution.submission)
          : `sha256:${"c".repeat(64)}`,
      },
      { actorBinding: reviewer, capability: "execution-review@v1", capabilityRef: "cap-review" },
    ),
    consent = make(
      owner,
      {
        type: "RecordReviewConsent",
        taskId,
        executionId,
        reviewId: currentReview?.reviewId ?? `review-${iteration}`,
        consentId: `consent-${iteration}`,
        reviewDigest: currentReview ? reviewDigest(currentReview) : `sha256:${"d".repeat(64)}`,
        contentDigest: currentReview?.contentDigest ?? `sha256:${"b".repeat(64)}`,
      },
      { actorBinding: owner, capability: "execution-consent@v1", capabilityRef: "cap-consent" },
    ),
    reconcile = make(
      owner,
      {
        type: "ReconcileCodeDoc",
        taskId,
        executionId,
        witnessId: `witness-${iteration}`,
        commitSha,
        iteration,
        paths: ["packages/kernel/src/index.ts"],
      },
      {
        actorBinding: owner,
        capability: "code-doc-reconcile@v1",
        capabilityRef: "cap-reconcile",
        commitPaths: { commitSha, paths: ["packages/kernel/src/index.ts"] },
      },
    ),
    repoint = make(
      owner,
      {
        type: "RepointCodeDoc",
        taskId,
        record: `witness-${iteration}`,
        repointId: `repoint-${iteration}`,
        commitSha,
        paths: ["packages/kernel/src/index.ts"],
        reason: "reachability",
      },
      {
        actorBinding: owner,
        capability: "code-doc-repoint@v1",
        capabilityRef: "cap-repoint",
        commitPaths: { commitSha, paths: ["packages/kernel/src/index.ts"] },
      },
    ),
    complete = make(
      owner,
      { type: "CompleteTask", taskId, executionId },
      {
        capability: "task-complete@v1",
        capabilityRef: "cap-complete",
        actorRole: "owner",
        noActiveLease: true,
        closeoutGates: { review: true, consent: true, fact: true, factDisposition: true, codeDoc: true },
        gateReceipts: [],
      },
    );
  return [
    make(
      owner,
      {
        type: "CreateReplayTask",
        taskId,
        title: "Reachability fixture",
        taskClass: "standard",
        graph: REPLAY_TASK_GRAPH,
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
      { taskIdUnique: true, actorBinding: owner },
    ),
    start,
    ...transitions,
    submit,
    ...adjudications,
    review,
    consent,
    reconcile,
    repoint,
    complete,
  ];
}

function coordinate(snapshot: TaskLifecycleSnapshot): string {
  const iteration = snapshot.task?.iteration;
  return JSON.stringify({
    task: snapshot.task && {
      status: snapshot.task.status,
      node: snapshot.task.currentNode,
    },
    executions: snapshot.executions
      .filter((value) => value.iteration === iteration)
      .map(({ state, submission }) => ({ state, submitted: submission !== null })),
    lease: snapshot.lease?.phase ?? null,
    reviews: snapshot.reviews.filter((value) => value.iteration === iteration).map(({ verdict }) => verdict),
    consent: snapshot.consents.some(({ executionId }) =>
      snapshot.executions.some((value) => value.iteration === iteration && value.executionId === executionId),
    ),
  });
}

test("every registry-reachable non-terminal task coordinate can reach done without cancellation", (t) => {
  assert.equal(
    stateTransition("transition"),
    null,
    "the action catalog must not publish a lossy TransitionTask state projection",
  );
  const root = emptyTaskLifecycleSnapshot(),
    rootKey = coordinate(root),
    snapshots = new Map([[rootKey, root]]),
    outgoing = new Map<string, Set<string>>(),
    matchedTransitions = new Set<(typeof TASK_LIFECYCLE_TRANSITIONS)[number]>(),
    queue = [rootKey];
  while (queue.length > 0) {
    const fromKey = queue.shift()!,
      snapshot = snapshots.get(fromKey)!;
    if (snapshot.task?.status === "done") continue;
    if (snapshot.task?.status === "cancelled") {
      for (const transition of TASK_LIFECYCLE_TRANSITIONS)
        if (candidates(snapshot).some((candidate) => transition.matches(candidate.command, snapshot)))
          matchedTransitions.add(transition);
      continue;
    }
    for (const transition of TASK_LIFECYCLE_TRANSITIONS) {
      for (const candidate of candidates(snapshot)) {
        if (!transition.matches(candidate.command, snapshot)) continue;
        matchedTransitions.add(transition);
        if (transition.validate(snapshot, candidate.command, candidate.proof).length > 0) continue;
        const next = applyTransition(snapshot, candidate.command, candidate.proof as never).snapshot,
          nextKey = coordinate(next);
        if (next.task?.status === "cancelled") {
          if (!snapshots.has(nextKey)) {
            snapshots.set(nextKey, next);
            queue.push(nextKey);
          }
          continue;
        }
        const targets = outgoing.get(fromKey) ?? new Set<string>();
        targets.add(nextKey);
        outgoing.set(fromKey, targets);
        if (!snapshots.has(nextKey)) {
          snapshots.set(nextKey, next);
          queue.push(nextKey);
        }
      }
    }
    assert.ok(snapshots.size < 200, "bounded search exceeded 199 coordinates");
  }
  const canReachDone = new Set(
    [...snapshots].filter(([, snapshot]) => snapshot.task?.status === "done").map(([key]) => key),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const [from, targets] of outgoing)
      if (!canReachDone.has(from) && [...targets].some((target) => canReachDone.has(target))) {
        canReachDone.add(from);
        changed = true;
      }
  }
  const stranded = [...snapshots]
    .filter(
      ([, snapshot]) =>
        snapshot.task !== null && snapshot.task.status !== "done" && snapshot.task.status !== "cancelled",
    )
    .map(([key]) => key)
    .filter((key) => !canReachDone.has(key));
  assert.deepEqual(
    TASK_LIFECYCLE_TRANSITIONS.flatMap((transition, index) => (matchedTransitions.has(transition) ? [] : [index])),
    [],
  );
  assert.deepEqual(stranded, []);
  const lifecycleActions = [...new Set(TASK_LIFECYCLE_TRANSITIONS.map(({ actionId }) => actionId))].map((actionId) => {
      const action = getTaskActionForTransition(actionId);
      assert.ok(action, `missing declaration for lifecycle action ${actionId}`);
      return action;
    }),
    nonTerminal = [...snapshots.values()].filter(
      (snapshot) => snapshot.task !== null && !["done", "cancelled"].includes(snapshot.task.status),
    ),
    terminal = [...snapshots.values()].filter((snapshot) =>
      ["done", "cancelled"].includes(snapshot.task?.status ?? ""),
    );
  t.diagnostic(
    `${nonTerminal.length} registry-reachable non-terminal coordinates × ${lifecycleActions.length} lifecycle commands`,
  );
  for (const snapshot of nonTerminal)
    for (const action of lifecycleActions) {
      const rejected = evaluateTaskActionCapability({
        action,
        snapshot,
        actor: owner,
        invocation: { taskId: snapshot.task!.taskId },
      }).some(({ status }) => status === "unmet");
      if (!rejected) continue;
      assert.notDeepEqual(
        taskLifecycleNextActions({
          snapshot,
          actor: owner,
          taskId: snapshot.task!.taskId,
          rejectedActionId: action.id,
          actions: lifecycleActions,
        }),
        [],
        `${coordinate(snapshot)} rejects ${action.id} without a derived next action`,
      );
    }
  assert.ok(terminal.length > 0, "the enumeration must explicitly observe terminal coordinates");
  for (const snapshot of terminal)
    assert.deepEqual(
      taskLifecycleNextActions({
        snapshot,
        actor: owner,
        taskId: snapshot.task!.taskId,
        rejectedActionId: "transition",
        actions: lifecycleActions,
      }),
      [],
      `${coordinate(snapshot)} is terminal and must be explicitly exempt from nextActions`,
    );
});
