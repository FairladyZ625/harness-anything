// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  canStartExecution,
  compileExecutionAnnotation,
  compileTaskLifecycleWrite,
  currentTaskForWrite,
  lifecycleDocumentPaths,
  reduceTaskEvent,
  submissionDigest,
  type TaskEventV1,
  type TaskLifecycleSnapshot,
  type TaskLifecycleCommand,
} from "../../src/index.ts";
import { lifecycleFixture, implementer, twoRoundLifecycleEvents } from "../store/task-lifecycle-fixture.ts";
import { closeoutReadiness } from "../../src/domain/closeout-readiness.ts";
import { validateTaskGraph } from "../../src/domain/task-graph.ts";
import {
  applyTransition,
  normalizeTaskLifecycleCommand,
  emptyTaskLifecycleSnapshot,
  validateTransition,
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

function lifecycleCommand(
  snapshot: TaskLifecycleSnapshot,
  intent: Parameters<typeof normalizeTaskLifecycleCommand>[1],
): TaskLifecycleCommand {
  return {
    ...normalizeTaskLifecycleCommand(
      { workspaceId: "workspace-1", actor: implementer, source: "local", expectedRevision: snapshot.revision },
      intent,
    ),
    eventId: `event-${snapshot.revision + 1}`,
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-09-17T03:00:00.000Z",
  } as TaskLifecycleCommand;
}

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

test("migration invalidation atomically abandons the execution and advances the task", () => {
  const task = {
      schema: "task/v2",
      taskId: "task-migration-invalidation",
      title: "Migration invalidation",
      taskClass: "standard",
      status: "active",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: actor,
      completionGateIds: [],
      presetSnapshotDigest: null,
      pinned: false,
      metadata,
    } as const,
    execution = {
      schema: "execution/v1",
      executionId: "execution-migration-invalidation",
      taskId: task.taskId,
      nodeId: "implementation",
      iteration: 0,
      state: "active",
      actor,
      claimedAt: "2026-09-17T00:00:00.000Z",
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
      expiresAt: "2026-09-18T00:00:00.000Z",
      ttlMs: 86_400_000,
      version: 1,
    } as const,
    snapshot: TaskLifecycleSnapshot = {
      ...emptyTaskLifecycleSnapshot(1),
      task,
      executions: [execution],
      lease,
    },
    invalidated: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-migration-invalidation",
      workspaceRevision: 2,
      opId: "op-migration-invalidation",
      taskId: task.taskId,
      type: "execution_invalidated",
      actor,
      source: "local",
      occurredAt: "2026-09-17T01:00:00.000Z",
      payload: {
        task: { ...task, status: "active", currentNode: "implementation", iteration: 1 },
        execution: { ...execution, state: "abandoned", closedAt: "2026-09-17T01:00:00.000Z" },
        reason: "generation-migration",
        releasedLease: lease,
        documentClaims: [],
      },
    };

  const replayed = reduceTaskEvent(snapshot, invalidated);
  assert.equal(replayed.executions[0]?.state, "abandoned");
  assert.equal(replayed.executions[0]?.closedAt, invalidated.occurredAt);
  assert.equal(replayed.task?.status, "active");
  assert.equal(replayed.task?.currentNode, "implementation");
  assert.equal(replayed.task?.iteration, 1);
  assert.equal(replayed.lease, null);
  assert.deepEqual(replayed.reviews, []);
  for (const payload of [
    { ...invalidated.payload, releasedLease: null },
    { ...invalidated.payload, execution: { ...invalidated.payload.execution, state: "submitted" as const } },
    { ...invalidated.payload, task: { ...invalidated.payload.task, iteration: 0 } },
  ])
    assert.throws(
      () => reduceTaskEvent(snapshot, { ...invalidated, payload } as TaskEventV1),
      /invalidation is incomplete/u,
    );
});

test("migration invalidation closes a submitted in-review execution without inventing a Review", () => {
  const fixture = lifecycleFixture({ complete: false });
  const snapshot = fixture.events.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const execution = snapshot.executions[0]!;
  const invalidated: TaskEventV1 = {
    schema: "task-event/v1",
    eventId: "event-migration-invalidation-submitted",
    workspaceRevision: snapshot.revision + 1,
    opId: "op-migration-invalidation-submitted",
    taskId: snapshot.task!.taskId,
    type: "execution_invalidated",
    actor,
    source: "local",
    occurredAt: "2026-09-17T02:00:00.000Z",
    payload: {
      task: { ...snapshot.task!, status: "active", currentNode: "implementation", iteration: 1 },
      execution: { ...execution, state: "abandoned", closedAt: "2026-09-17T02:00:00.000Z" },
      reason: "generation-migration",
      releasedLease: null,
      documentClaims: [],
    },
  };
  const replayed = reduceTaskEvent(snapshot, invalidated);
  assert.equal(replayed.executions[0]?.state, "abandoned");
  assert.equal(replayed.reviews.length, snapshot.reviews.length);
  assert.equal(replayed.task?.status, "active");
  assert.equal(replayed.task?.iteration, 1);
  assert.equal(canStartExecution(replayed, execution.executionId), false, "the invalidated executor cannot reconnect");
  const submission = execution.submission!;
  const rejected = [
    lifecycleCommand(replayed, {
      type: "SubmitExecution",
      taskId: execution.taskId,
      executionId: execution.executionId,
      submission,
    }),
    lifecycleCommand(replayed, {
      type: "RecordReview",
      taskId: execution.taskId,
      executionId: execution.executionId,
      reviewId: "review-stale-worker",
      verdict: "approved",
      reason: "stale result",
      evidenceChecked: ["stale result"],
      commitSha: submission.commitSha,
      iteration: execution.iteration,
      contentDigest: `sha256:${"a".repeat(64)}`,
      submissionDigest: submissionDigest(submission),
    }),
  ];
  for (const command of rejected)
    assert.ok(
      validateTransition(replayed, command, {} as never).some((issue) => issue.code === "invalid_transition"),
      `${command.type} must reject an invalidated execution`,
    );
});

function legacyCompletion() {
  // The gated fixture stops before CompleteTask: an unwitnessed cut cannot complete through the
  // command path, which is exactly the historical-acceptance asymmetry this replay test exercises.
  const fixture = lifecycleFixture({
    gates: [
      {
        gateId: "ci",
        appliesTo: "code" as const,
        witness: {
          adapterId: "github-actions" as const,
          adapterOptions: {
            workflows: ["rewrite-ci"],
            branch: "main",
            event: "push",
            coverage: "exact" as const,
            selection: "newest" as const,
          },
        },
      },
    ],
    complete: false,
  });
  let snapshot = fixture.events.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  const current = snapshot.executions[0]!;
  snapshot = {
    ...snapshot,
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
  // The accepted completion event is historical input: fabricate it the way a migrated ledger
  // carries it, since the current command path would never admit this cut.
  const completed: TaskEventV1 = {
    schema: "task-event/v1",
    eventId: "event-complete",
    workspaceRevision: snapshot.revision + 1,
    opId: "op-complete",
    taskId: current.taskId,
    type: "task_completed",
    actor: implementer,
    source: "local",
    occurredAt: "2026-08-11T00:05:00.000Z",
    payload: {
      task: { ...snapshot.task!, status: "done" },
      execution: { ...current, state: "accepted", closedAt: "2026-08-11T00:05:00.000Z" },
      closeoutGates: { review: true, consent: true, factDisposition: true, codeDoc: true },
      documentClaims: [],
    },
  };
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

test("execution annotation appends one note to a historical execution without rewriting it", () => {
  const { snapshot } = twoRoundLifecycleEvents(),
    historical = snapshot.executions.find((value) => value.executionId === "execution-round-one")!,
    compiled = compileExecutionAnnotation({
      snapshot,
      taskId: "task-two-round",
      executionId: "execution-round-one",
      actor: implementer,
      source: "local",
      kind: "superseded-by",
      note: "Superseded by execution-round-two after requested changes.",
      opId: "op-annotate",
      eventId: "event-annotate",
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-08-11T00:10:00.000Z",
    });
  assert.equal(compiled.event.type, "execution_annotated");
  const annotated = compiled.snapshot.executions.find((value) => value.executionId === "execution-round-one")!,
    current = compiled.snapshot.executions.find((value) => value.executionId === "execution-round-two")!;
  // Original record fields are untouched; only the append-only notes list grew.
  const { annotations: _annotations, ...rest } = annotated;
  assert.deepEqual(rest, historical);
  assert.deepEqual(annotated.annotations, [
    {
      kind: "superseded-by",
      note: "Superseded by execution-round-two after requested changes.",
      actor: implementer,
      annotatedAt: "2026-08-11T00:10:00.000Z",
    },
  ]);
  assert.equal(current.annotations, undefined);
  assert.equal(compiled.snapshot.task?.iteration, snapshot.task?.iteration);
  // The write plan rewrites only the annotated Execution's record, even for a past iteration.
  assert.deepEqual(lifecycleDocumentPaths(compiled.event, "tasks/task-two-round"), [
    "tasks/task-two-round/executions/execution-round-one.md",
  ]);
  const write = compileTaskLifecycleWrite({
    event: compiled.event,
    snapshot: compiled.snapshot,
    packagePath: "tasks/task-two-round",
    currentDocuments: [],
  });
  assert.deepEqual(write.changedPaths, ["tasks/task-two-round/executions/execution-round-one.md"]);
  assert.match(
    write.blobs[0]!.body,
    /## Annotations\n\n- 2026-08-11T00:10:00\.000Z superseded-by by person-owner: Superseded by execution-round-two/u,
  );
  // Replay of the canonical event lands the same snapshot; a payload that does not append the
  // envelope-pinned note is rejected, so history stays append-only.
  assert.deepEqual(reduceTaskEvent(snapshot, compiled.event), compiled.snapshot);
  const tampered = {
    ...compiled.event,
    payload: { ...compiled.event.payload, execution: historical },
  } as TaskEventV1;
  assert.throws(() => reduceTaskEvent(snapshot, tampered), /append exactly one/u);
  for (const invalid of [
    { executionId: "execution-missing" },
    { note: "   " },
    { kind: "obsolete" as never },
    { workspaceRevision: snapshot.revision },
  ])
    assert.throws(
      () =>
        compileExecutionAnnotation({
          snapshot,
          taskId: "task-two-round",
          executionId: "execution-round-one",
          actor: implementer,
          source: "local",
          kind: "correction",
          note: "correction",
          opId: "op-annotate",
          eventId: "event-annotate",
          workspaceRevision: snapshot.revision + 1,
          occurredAt: "2026-08-11T00:10:00.000Z",
          ...invalid,
        }),
      /annotation|append/u,
    );
});
