// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  currentTaskForWrite,
  reduceTaskEvent,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
} from "../../src/index.ts";
import { lifecycleFixture, implementer } from "../store/task-lifecycle-fixture.ts";
import { closeoutReadiness } from "../../src/domain/closeout-readiness.ts";
import { validateTaskGraph } from "../../src/domain/task-graph.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  emptyTaskLifecycleSnapshot,
} from "../../src/domain/task-lifecycle.contract.ts";

const actor = { principal: { personId: "person-owner" }, executor: null } as const;
const metadata = {
  idempotencyKey: null,
  parentTaskId: null,
  workKind: "fix" as const,
  riskTier: "medium" as const,
  urgency: null,
  verticalId: "software/coding",
  presetId: "standard-task",
  profileId: "baseline",
  moduleKey: null,
  slug: "legacy-release",
  surfaces: [] as readonly string[],
  fromLegacyId: null,
};

test("lease release replay ignores only the retired longRunning task metadata", () => {
  const task = {
      schema: "task/v2",
      taskId: "task-legacy-release",
      title: "Legacy release",
      taskClass: "standard",
      status: "active",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
      pinned: false,
      metadata: { ...metadata, longRunning: false },
    } as const,
    execution = {
      schema: "execution/v1",
      executionId: "execution-legacy-release",
      taskId: task.taskId,
      nodeId: "implementation",
      iteration: 0,
      state: "active",
      actor,
      claimedAt: "2026-08-15T20:36:06.914Z",
      submittedAt: null,
      closedAt: null,
      submission: null,
    } as const,
    lease = {
      schema: "lease/v1",
      taskId: task.taskId,
      executionId: execution.executionId,
      actor,
      source: "local",
      phase: "held",
      expiresAt: "2026-08-15T21:06:06.914Z",
      ttlMs: 1_800_000,
      version: 1,
    } as const,
    snapshot: TaskLifecycleSnapshot = {
      ...emptyTaskLifecycleSnapshot(1),
      task,
      executions: [execution],
      lease,
    },
    release: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-release",
      workspaceRevision: 2,
      opId: "op-release",
      taskId: task.taskId,
      type: "lease_released",
      actor,
      source: "local",
      occurredAt: "2026-08-24T01:05:05.136Z",
      payload: {
        task: currentTaskForWrite(task),
        execution,
        releasedLease: { ...lease, phase: "orphaned" },
        mutation: { command: "release", reason: "expired lease", fields: ["lease"] },
        documentClaims: [],
      },
    };

  assert.equal(reduceTaskEvent(snapshot, release).lease, null);
  assert.throws(
    () =>
      reduceTaskEvent(snapshot, {
        ...release,
        payload: { ...release.payload, task: { ...release.payload.task, title: "Changed" } },
      }),
    /replayed lease release is incomplete/u,
  );
});

function legacyCompletion() {
  const fixture = lifecycleFixture();
  let snapshot = fixture.events.slice(0, -1).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const current = snapshot.executions[0]!;
  snapshot = {
    ...snapshot,
    task: { ...snapshot.task!, completionGateIds: ["ci"] },
    gateWitnesses: [
      {
        schema: "completion-gate-witness/v1",
        witnessId: "gate-legacy",
        taskId: current.taskId,
        executionId: current.executionId,
        gateId: "ci",
        checkerId: "standard",
        receiptId: "op-legacy-ci",
        commitSha: current.submission!.commitSha,
        iteration: current.iteration,
        result: "pass",
        actor: implementer,
        source: "local",
        verifiedAt: "2026-08-11T00:04:30.000Z",
      },
    ],
  };
  const last = fixture.events.at(-1)!;
  assert.equal(last.type, "task_completed");
  const completed = {
    ...last,
    payload: { ...last.payload, task: { ...snapshot.task!, status: "done" } },
  } as TaskEventV1;
  return { snapshot, completed, current };
}

test("accepted completion keeps legacy receipts without admitting a new unbound completion", () => {
  const { snapshot, completed, current } = legacyCompletion();
  const replayed = reduceTaskEvent(snapshot, completed);
  assert.equal(replayed.task?.status, "done");
  assert.equal(replayed.executions[0]?.state, "accepted");
  assert.deepEqual(replayed.gateWitnesses, snapshot.gateWitnesses);
  assert.equal(replayed.gateWitnesses[0]?.basis, undefined);
  assert.equal(closeoutReadiness(snapshot).readiness, "incomplete");
  const command = normalizeTaskLifecycleCommand(
    { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
    { type: "CompleteTask", taskId: current.taskId, executionId: current.executionId },
  );
  assert.throws(
    () =>
      applyTransition(snapshot, command, {
        capability: "task-complete@v1",
        capabilityRef: "cap-complete",
        actorRole: "owner",
        noActiveLease: true,
        closeoutGates: { review: true, consent: true, factDisposition: true, codeDoc: true },
        gateReceipts: [],
      }),
    /gate|witness|completion/i,
  );
});

test("accepted history still rejects missing approval and mismatched gate bindings", () => {
  const { snapshot, completed } = legacyCompletion();
  for (const invalid of [
    { ...snapshot, task: { ...snapshot.task!, iteration: snapshot.task!.iteration + 1 } },
    { ...snapshot, reviews: [] },
    { ...snapshot, consents: [] },
    { ...snapshot, gateWitnesses: [] },
    { ...snapshot, gateWitnesses: snapshot.gateWitnesses.map((w) => ({ ...w, commitSha: "b".repeat(40) })) },
    { ...snapshot, gateWitnesses: snapshot.gateWitnesses.map((w) => ({ ...w, executionId: "other-execution" })) },
  ])
    assert.throws(() => reduceTaskEvent(invalid, completed), /accepted task and execution state/);
});

test("a graph stored with the retired maxIterations field still validates strictly", () => {
  assert.deepEqual(validateTaskGraph({ ...REPLAY_TASK_GRAPH, maxIterations: 1 }), []);
  assert.equal(validateTaskGraph({ ...REPLAY_TASK_GRAPH, maxIterationz: 1 }).length, 1);
});
