// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type ActorIdentity, type LeaseV1, type TaskLifecycleSnapshot, type TaskV2 } from "@harness-anything/kernel";
import { taskSurfaceWrite } from "../src/repo-cell-task-command-docs.ts";
import { taskMutation } from "../src/repo-cell-task-mutation.ts";
import {
  appendRuntimeWorkerRecord,
  openDispatchStream,
  removeDispatchLiveIndexEntries,
  removeDispatchStream,
} from "../src/dispatch-stream.ts";

const now = "2026-08-25T03:15:20.000Z";
const owner = (executorId: string): ActorIdentity => ({
  principal: { personId: "person-owner" },
  executor: { kind: "agent", id: executorId },
});
const task: TaskV2 = {
  schema: "task/v2",
  taskId: "task-orphaned-reservation",
  title: "Orphaned reservation",
  taskClass: "standard",
  status: "active",
  graph: { maxIterations: 1, nodes: [], edges: [] },
  currentNode: "implementation",
  iteration: 0,
  createdBy: owner("creator"),
  completionGateIds: [],
  presetSnapshotDigest: null,
  pinned: false,
};
const lease: LeaseV1 = {
  schema: "lease/v1",
  taskId: task.taskId,
  executionId: "exec-orphaned-reservation",
  actor: owner("original-worker"),
  source: "local",
  phase: "held",
  expiresAt: "2026-08-26T03:15:20.000Z",
  ttlMs: 86_400_000,
  version: 7,
};
const authorized = (actionActor: ActorIdentity) => ({
  actor: actionActor,
  source: "local" as const,
  authorizationDecision: {
    policyRef: "keycloak-policy@1",
    actor: actionActor,
    subject: `task/${task.taskId}` as const,
    bindingsUsed: [{ authority: "keycloak", scope: "task-release" }],
    outcome: "allowed" as const,
    reasonCodes: ["keycloak_allowed"],
    nextActions: [],
    evaluatedAtCut: "canonical:8",
  },
});
const cell = {
  now: () => now,
  cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
};
const snapshot = (): TaskLifecycleSnapshot => ({
  revision: 8,
  task,
  executions: [],
  reviews: [],
  consents: [],
  gateWitnesses: [],
  edgesTaken: [],
  lease,
});

test("same principal can reclaim a live reservation with no published execution", () => {
  const mutation = taskMutation(
    cell,
    { kind: "task-release", taskId: task.taskId, reason: "Recover my interrupted reservation." },
    task,
    snapshot(),
    authorized(owner("replacement-worker")),
  );

  assert.equal(mutation.type, "lease_released");
  assert.equal(mutation.execution, undefined);
  assert.equal(mutation.releasedLease, lease);
});

test("same principal release settles a canonical-free reservation in the local CAS", () => {
  let released: LeaseV1 | null = null;
  const surfaceCell = {
      ...cell,
      input: { repoId: "lease-reservation-contract" },
      requiredCellText: (value: unknown) => String(value),
      projection: {
        read: () => ({ status: "ready", snapshot: snapshot(), packagePath: "tasks/task-orphaned-reservation" }),
        releaseLease: (value: LeaseV1) => {
          released = value;
        },
      },
      projectionReady: () => true,
      taskMutation: (
        action: Parameters<typeof taskMutation>[1],
        currentTask: Parameters<typeof taskMutation>[2],
        currentSnapshot: Parameters<typeof taskMutation>[3],
        binding: Parameters<typeof taskMutation>[4],
      ) => taskMutation(cell, action, currentTask, currentSnapshot, binding),
      withoutDryRun: (action: unknown) => action,
      operationId: () => "op-release-orphaned-reservation",
      store: {
        read: () => ({ events: [] }),
        readHead: () => ({ revision: 8 }),
      },
    },
    receipt = taskSurfaceWrite(
      surfaceCell,
      { kind: "task-release", taskId: task.taskId },
      authorized(owner("replacement-worker")),
    );

  assert.equal(receipt.outcome, "no_changes");
  assert.equal(receipt.code, "no_changes");
  assert.equal(released, lease);
});

test("a different principal cannot reclaim the reservation before TTL", () => {
  assert.throws(
    () =>
      taskMutation(
        cell,
        { kind: "task-release", taskId: task.taskId },
        task,
        snapshot(),
        authorized({
          principal: { personId: "person-outsider" },
          executor: { kind: "agent", id: "outsider-worker" },
        }),
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
  );
});

test("the task owner can reclaim an orphaned lease held by another principal", () => {
  const taskOwner = owner("task-owner"),
    foreignLease = {
      ...lease,
      actor: {
        principal: { personId: "person-worker" },
        executor: { kind: "agent" as const, id: "departed-worker" },
      },
      phase: "orphaned" as const,
    },
    ownedTask = { ...task, createdBy: taskOwner },
    ownedSnapshot = { ...snapshot(), task: ownedTask, lease: foreignLease };
  const mutation = taskMutation(
    cell,
    { kind: "task-release", taskId: task.taskId, reason: "The worker is gone." },
    ownedTask,
    ownedSnapshot,
    authorized({ principal: taskOwner.principal, executor: null }),
  );

  assert.equal(mutation.type, "lease_released");
  assert.equal(mutation.releasedLease, foreignLease);
});

test("a stale RuntimeSession terminal cannot release a newer execution lease", () => {
  assert.throws(
    () =>
      taskMutation(
        cell,
        {
          kind: "task-release",
          taskId: task.taskId,
          terminalExecutionId: "exec-previous",
          terminalRuntimeSessionId: "runtime-previous",
        },
        task,
        snapshot(),
        authorized(owner("replacement-worker")),
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_terminal_superseded",
  );
});

test("the task owner reclaims a held lease from an exited holder across execution drift", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-terminal-lease-reclaim-")),
    runtimeSessionId = "runtime-terminal-owner-reclaim",
    taskOwner = owner("task-owner"),
    worker = {
      principal: { personId: "person-worker" },
      executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
    },
    heldLease = { ...lease, actor: worker },
    ownedTask = { ...task, createdBy: taskOwner },
    execution = {
      schema: "execution/v1" as const,
      executionId: heldLease.executionId,
      taskId: heldLease.taskId,
      nodeId: "implementation" as const,
      iteration: 0 as const,
      state: "active" as const,
      actor: worker,
      claimedAt: now,
      submittedAt: null,
      closedAt: null,
      submission: null,
    },
    runtimeSession = {
      runtimeSessionId,
      instanceId: "codex-test",
      installationId: "installation-test",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      providerSessionId: "provider-test",
      transcriptRef: "file:transcript.jsonl",
      launchGeneration: 1,
      liveness: "exited" as const,
      attachable: false,
      taskBindings: [
        {
          taskId: heldLease.taskId,
          executionId: "exec-original-dispatch",
          providerSessionId: "provider-test",
          transcriptRef: "file:transcript.jsonl",
          boundAt: now,
        },
      ],
      outcome: "succeeded" as const,
      exitCode: 0,
      resultRef: "artifact:runtime-result/test",
      lastObservedAt: now,
    },
    terminalCell = {
      ...cell,
      rootDir,
      projection: { readRuntimeSessionsForTask: () => [runtimeSession] },
    },
    terminalSnapshot = { ...snapshot(), task: ownedTask, executions: [execution], lease: heldLease },
    taskOwnerBinding = authorized({ principal: taskOwner.principal, executor: null });
  try {
    const proofDispatchId = "dispatch_" + "d".repeat(24);
    openDispatchStream(rootDir, {
      dispatchId: proofDispatchId,
      taskId: heldLease.taskId,
      executionId: heldLease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    });
    appendRuntimeWorkerRecord(rootDir, proofDispatchId, { kind: "process_started", pid: 2_147_483_647 });
    const mutation = taskMutation(
      terminalCell,
      { kind: "task-release", taskId: task.taskId, reason: "The bound worker exited." },
      ownedTask,
      terminalSnapshot,
      taskOwnerBinding,
    );
    assert.equal(mutation.type, "lease_released");
    assert.equal(mutation.releasedLease, heldLease);
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { kind: "task-release", taskId: task.taskId },
          ownedTask,
          {
            ...terminalSnapshot,
            lease: {
              ...heldLease,
              actor: { ...worker, executor: { kind: "agent", id: "runtime-session:another-holder" } },
            },
          },
          taskOwnerBinding,
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
      "an exited RuntimeSession cannot prove a newer holder is dead",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the same principal recovers an exited holder after settlement removes its dispatch from the live index", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settled-dispatch-lease-reclaim-")),
    runtimeSessionId = "runtime-settled-dispatch-reclaim",
    holder = {
      principal: { personId: "person-worker" },
      executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
    },
    heldLease = { ...lease, actor: holder },
    execution = {
      schema: "execution/v1" as const,
      executionId: heldLease.executionId,
      taskId: heldLease.taskId,
      nodeId: "implementation" as const,
      iteration: 0 as const,
      state: "active" as const,
      actor: holder,
      claimedAt: now,
      submittedAt: null,
      closedAt: null,
      submission: null,
    },
    sessionFor = (liveness: "live" | "exited") => ({
      runtimeSessionId,
      instanceId: "codex-test",
      installationId: "installation-test",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      providerSessionId: "provider-test",
      transcriptRef: "file:transcript.jsonl",
      launchGeneration: 1,
      liveness,
      attachable: liveness === "live",
      taskBindings: [
        {
          taskId: heldLease.taskId,
          executionId: heldLease.executionId,
          providerSessionId: "provider-test",
          transcriptRef: "file:transcript.jsonl",
          boundAt: now,
        },
      ],
      outcome: liveness === "exited" ? ("succeeded" as const) : null,
      exitCode: liveness === "exited" ? 0 : null,
      resultRef: liveness === "exited" ? "artifact:runtime-result/test" : null,
      lastObservedAt: now,
    }),
    cellFor = (session: ReturnType<typeof sessionFor>) => ({
      ...cell,
      rootDir,
      projection: { readRuntimeSessionsForTask: () => [session] },
    }),
    snapshotFor = () => ({ ...snapshot(), executions: [execution], lease: heldLease }),
    replacement = authorized({
      principal: { personId: "person-worker" },
      executor: { kind: "agent", id: "replacement-worker" },
    }),
    dispatchId = "dispatch_cccccccccccccccccccccccc";
  try {
    const stream = openDispatchStream(rootDir, {
      dispatchId,
      taskId: heldLease.taskId,
      executionId: heldLease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    stream.appendAttemptOutcome(
      {
        classification: "worker_stop",
        reason: "Worker reached a normal attempt boundary.",
        provider: { instance: "codex-test", model: "test-model", kind: "codex" },
        attemptGroupId: dispatchId,
        attemptIndex: 0,
      },
      now,
    );
    removeDispatchLiveIndexEntries(rootDir, [{ dispatchId, taskId: heldLease.taskId, runtimeSessionId }]);

    assert.throws(
      () =>
        taskMutation(
          cellFor(sessionFor("live")),
          { kind: "task-release", taskId: task.taskId, reason: "Explicit handoff cannot release a live runtime." },
          task,
          snapshotFor(),
          replacement,
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
      "a live holder keeps its lease even when settlement dropped the dispatch from the live index",
    );

    const mutation = taskMutation(
      cellFor(sessionFor("exited")),
      { kind: "task-release", taskId: task.taskId, reason: "The holder session exited after settlement." },
      task,
      snapshotFor(),
      replacement,
    );
    assert.equal(mutation.type, "lease_released");
    assert.equal(mutation.releasedLease, heldLease);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the same principal reclaims a live-projected RuntimeSession only after its dispatch process dies", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dead-runtime-lease-reclaim-")),
    runtimeSessionId = "runtime-dead-process-reclaim",
    runtimeActor = {
      principal: { personId: "person-owner" },
      executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
    },
    heldLease = { ...lease, actor: runtimeActor },
    execution = {
      schema: "execution/v1" as const,
      executionId: heldLease.executionId,
      taskId: heldLease.taskId,
      nodeId: "implementation" as const,
      iteration: 0 as const,
      state: "active" as const,
      actor: runtimeActor,
      claimedAt: now,
      submittedAt: null,
      closedAt: null,
      submission: null,
    },
    runtimeSession = {
      runtimeSessionId,
      instanceId: "codex-test",
      installationId: "installation-test",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/test",
      providerSessionId: null,
      transcriptRef: null,
      launchGeneration: 1,
      liveness: "live" as const,
      attachable: true,
      taskBindings: [
        {
          taskId: heldLease.taskId,
          executionId: heldLease.executionId,
          providerSessionId: null,
          transcriptRef: null,
          boundAt: now,
        },
      ],
      outcome: null,
      exitCode: null,
      resultRef: null,
      lastObservedAt: now,
    },
    reclaimCell = {
      ...cell,
      rootDir,
      projection: { readRuntimeSessionsForTask: () => [runtimeSession] },
    },
    heldSnapshot = { ...snapshot(), executions: [execution], lease: heldLease },
    replacement = authorized(owner("replacement-worker")),
    dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb";
  try {
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: heldLease.taskId,
      executionId: heldLease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
    assert.throws(
      () => taskMutation(reclaimCell, { kind: "task-release", taskId: task.taskId }, task, heldSnapshot, replacement),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
      "a live dispatch process must retain its lease",
    );

    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    const mutation = taskMutation(
      reclaimCell,
      { kind: "task-release", taskId: task.taskId, reason: "The bound dispatch process is gone." },
      task,
      heldSnapshot,
      replacement,
    );
    assert.equal(mutation.type, "lease_released");
    assert.equal(mutation.releasedLease, heldLease);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("terminal runtime lease release requires a process-group stop proof", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-terminal-process-group-proof-")),
    runtimeSessionId = "runtime-terminal-proof",
    dispatchId = "dispatch_cccccccccccccccccccccccc",
    orphanedLease = { ...lease, phase: "orphaned" as const },
    edgeSource = { kind: "node" as const, nodeId: "edge-terminal-proof" };
  let runtimeEvents: Array<{ type: string; source: unknown; payload: Record<string, unknown> }> = [];
  const terminalCell = {
      ...cell,
      rootDir,
      projection: { readRuntimeSessionEvents: () => runtimeEvents },
    },
    terminalAction = {
      kind: "task-release" as const,
      taskId: task.taskId,
      terminalExecutionId: lease.executionId,
      terminalRuntimeSessionId: runtimeSessionId,
    },
    sessionStarted = (source: unknown = "local", bindTask = true) => ({
      type: "runtime_session_started",
      source,
      payload: {
        runtimeSessionId,
        ...(bindTask ? { taskBinding: { taskId: task.taskId, executionId: lease.executionId } } : {}),
      },
    });
  try {
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          terminalAction,
          task,
          { ...snapshot(), lease: orphanedLease },
          authorized(owner("replacement-worker")),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
    );
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
          task,
          { ...snapshot(), lease: orphanedLease },
          authorized(owner("replacement-worker")),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "an unrelated stopped pid without a matching RuntimeSession start cannot prove this runtime stopped",
    );
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: task.taskId,
      executionId: lease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    });
    runtimeEvents = [sessionStarted()];
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 1, signal: null });
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          terminalAction,
          task,
          { ...snapshot(), lease: orphanedLease },
          authorized(owner("replacement-worker")),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "process_exit without a process-group witness only proves the worker host closed",
    );
    removeDispatchStream(rootDir, dispatchId);

    openDispatchStream(rootDir, {
      dispatchId,
      taskId: task.taskId,
      executionId: lease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_start_rejected", errorCode: "fixture_refused" });
    const rejectedLaunchMutation = taskMutation(
      terminalCell,
      terminalAction,
      task,
      { ...snapshot(), lease: orphanedLease },
      authorized(owner("replacement-worker")),
    );
    assert.equal(
      rejectedLaunchMutation.type,
      "lease_released",
      "explicit pre-spawn rejection proves no process group was created",
    );
    removeDispatchStream(rootDir, dispatchId);

    runtimeEvents = [sessionStarted()];
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
          task,
          { ...snapshot(), lease: orphanedLease },
          authorized(owner("replacement-worker")),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "a local caller cannot substitute an unrecorded process group",
    );

    runtimeEvents = [sessionStarted({ kind: "node", nodeId: "another-edge" })];
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
          task,
          { ...snapshot(), lease: orphanedLease },
          { ...authorized(owner("replacement-worker")), source: edgeSource },
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "an Edge PID is bound to the node that published the matching RuntimeSession start",
    );

    runtimeEvents = [sessionStarted(edgeSource)];
    const edgeMutation = taskMutation(
      terminalCell,
      { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
      task,
      { ...snapshot(), lease: orphanedLease },
      { ...authorized(owner("replacement-worker")), source: edgeSource },
    );
    assert.equal(edgeMutation.type, "lease_released", "a matching Edge start binds its locally proven PID");

    runtimeEvents = [sessionStarted(edgeSource, false)];
    const unboundEdgeMutation = taskMutation(
      terminalCell,
      { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
      task,
      { ...snapshot(), lease: orphanedLease },
      { ...authorized(owner("replacement-worker")), source: edgeSource },
    );
    assert.equal(
      unboundEdgeMutation.type,
      "lease_released",
      "a matching RuntimeSession start with no taskBinding still binds the lease's supplied Edge proof",
    );

    runtimeEvents = [{ type: "runtime_session_exited", source: "local", payload: { runtimeSessionId } }];
    const exitedMutation = taskMutation(
      terminalCell,
      terminalAction,
      task,
      { ...snapshot(), lease: orphanedLease },
      authorized(owner("replacement-worker")),
    );
    assert.equal(exitedMutation.type, "lease_released", "an exited session with no recorded PID is terminal evidence");
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
          task,
          { ...snapshot(), lease: orphanedLease },
          authorized(owner("replacement-worker")),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "an unrelated supplied PID cannot replace the exited session's missing process-group witness",
    );

    runtimeEvents = [
      sessionStarted(edgeSource),
      {
        type: "runtime_session_liveness_changed",
        source: edgeSource,
        payload: { runtimeSessionId, liveness: "live", processGroupPid: 12345 },
      },
    ];
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
          task,
          { ...snapshot(), lease: orphanedLease },
          { ...authorized(owner("replacement-worker")), source: edgeSource },
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "a supplied Edge PID cannot contradict a PID recorded by the matching RuntimeSession",
    );

    runtimeEvents = [];

    openDispatchStream(rootDir, {
      dispatchId,
      taskId: task.taskId,
      executionId: lease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
          task,
          { ...snapshot(), lease: orphanedLease },
          authorized(owner("replacement-worker")),
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
      "an unrelated stopped process group cannot prove this runtime stopped",
    );
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    const mutation = taskMutation(
      terminalCell,
      { ...terminalAction, terminalProcessGroupPid: 2_147_483_647 },
      task,
      { ...snapshot(), lease: orphanedLease },
      authorized(owner("replacement-worker")),
    );
    assert.equal(mutation.type, "lease_released");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
