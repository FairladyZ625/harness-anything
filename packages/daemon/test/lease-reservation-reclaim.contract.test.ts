// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type ActorIdentity, type LeaseV1, type TaskLifecycleSnapshot, type TaskV1 } from "../../kernel/src/index.ts";
import { taskSurfaceWrite } from "../src/repo-cell-task-command-docs.ts";
import { taskMutation } from "../src/repo-cell-task-command.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";

const now = "2026-08-25T03:15:20.000Z";
const owner = (executorId: string): ActorIdentity => ({
  principal: { personId: "person-owner" },
  executor: { kind: "agent", id: executorId },
});
const task: TaskV1 = {
  schema: "task/v1",
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
  codeDocWitnesses: [],
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
    { actor: owner("replacement-worker"), source: "local" },
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
      { actor: owner("replacement-worker"), source: "local" },
    );

  assert.equal(receipt.outcome, "no_changes");
  assert.equal(receipt.code, "no_changes");
  assert.equal(released, lease);
});

test("a different principal cannot reclaim the reservation before TTL", () => {
  assert.throws(
    () =>
      taskMutation(cell, { kind: "task-release", taskId: task.taskId }, task, snapshot(), {
        actor: {
          principal: { personId: "person-outsider" },
          executor: { kind: "agent", id: "outsider-worker" },
        },
        source: "local",
      }),
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
    { actor: { principal: taskOwner.principal, executor: null }, source: "local" },
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
        { actor: owner("replacement-worker"), source: "local" },
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_terminal_superseded",
  );
});

test("the task owner reclaims a held lease after its bound dispatch reaches a terminal attempt", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-terminal-lease-reclaim-")),
    taskOwner = owner("task-owner"),
    worker = {
      principal: { personId: "person-worker" },
      executor: { kind: "agent" as const, id: "departed-worker" },
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
    runtimeSessionId = "runtime-terminal-owner-reclaim",
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
          executionId: heldLease.executionId,
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
    taskOwnerBinding = { actor: { principal: taskOwner.principal, executor: null }, source: "local" as const };
  try {
    assert.throws(
      () =>
        taskMutation(
          terminalCell,
          { kind: "task-release", taskId: task.taskId },
          ownedTask,
          terminalSnapshot,
          taskOwnerBinding,
        ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
      "a RuntimeSession row without a terminal dispatch record is insufficient",
    );
    openDispatchStream(rootDir, {
      dispatchId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      taskId: heldLease.taskId,
      executionId: heldLease.executionId,
      runtimeSessionId,
      instanceId: "codex-test",
      startedAt: now,
    }).appendAttemptOutcome(
      {
        classification: "worker_stop",
        reason: "Worker reached a normal attempt boundary.",
        provider: { instance: "codex-test", model: "test-model", kind: "codex" },
        attemptGroupId: "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
        attemptIndex: 0,
      },
      now,
    );

    const mutation = taskMutation(
      terminalCell,
      { kind: "task-release", taskId: task.taskId, reason: "The bound worker exited." },
      ownedTask,
      terminalSnapshot,
      taskOwnerBinding,
    );
    assert.equal(mutation.type, "lease_released");
    assert.equal(mutation.releasedLease, heldLease);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
