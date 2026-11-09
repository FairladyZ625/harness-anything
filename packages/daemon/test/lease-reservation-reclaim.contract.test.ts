// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { type ActorIdentity, type LeaseV1, type TaskLifecycleSnapshot, type TaskV2 } from "@harness-anything/kernel";
import { taskSurfaceWrite } from "../src/repo-cell-task-command-docs.ts";
import { taskMutation } from "../src/repo-cell-task-mutation.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

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

function lifecycleProjection(runtimeSessionId: string, phase: "running" | "stopped", executionId = lease.executionId) {
  const dispatchId = `dispatch-${runtimeSessionId}`,
    source = "local" as const,
    events = [
      lifecycleEvent("R", runtimeSessionId, {
        instanceId: "codex-test",
        source,
        dispatchId,
        taskId: task.taskId,
        executionId,
      }),
      ...(phase === "running"
        ? [lifecycleEvent("S", runtimeSessionId, { instanceId: "codex-test", source })]
        : [lifecycleEvent("X", runtimeSessionId, { instanceId: "codex-test", source })]),
    ],
    session = {
      runtimeSessionId,
      taskBindings: [{ taskId: task.taskId, executionId: lease.executionId }],
    };
  return {
    readRuntimeSession: (id: string) => (id === runtimeSessionId ? session : null),
    readDispatchLifecycle: dispatchLifecycleReadOf(() => events),
  };
}

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

test("the task owner reclaims a held lease from a stopped lifecycle attempt across execution drift", () => {
  const runtimeSessionId = "runtime-terminal-owner-reclaim",
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
      projection: {
        ...lifecycleProjection(runtimeSessionId, "stopped", "exec-original-dispatch"),
        readRuntimeSession: (id: string) => (id === runtimeSession.runtimeSessionId ? runtimeSession : null),
      },
    },
    terminalSnapshot = { ...snapshot(), task: ownedTask, executions: [execution], lease: heldLease },
    taskOwnerBinding = authorized({ principal: taskOwner.principal, executor: null });
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
    "a lifecycle proof for another RuntimeSession cannot release this lease",
  );
});

test("the same principal can recover a lease only after the matching lifecycle attempt stops", () => {
  const runtimeSessionId = "runtime-settled-dispatch-reclaim",
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
    cellFor = (session: ReturnType<typeof sessionFor>, phase: "running" | "stopped") => ({
      ...cell,
      projection: {
        ...lifecycleProjection(runtimeSessionId, phase),
        readRuntimeSession: (id: string) => (id === session.runtimeSessionId ? session : null),
      },
    }),
    snapshotFor = () => ({ ...snapshot(), executions: [execution], lease: heldLease }),
    replacement = authorized({
      principal: { personId: "person-worker" },
      executor: { kind: "agent", id: "replacement-worker" },
    });

  assert.throws(
    () =>
      taskMutation(
        cellFor(sessionFor("live"), "running"),
        { kind: "task-release", taskId: task.taskId, reason: "Explicit handoff cannot release a live runtime." },
        task,
        snapshotFor(),
        replacement,
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "lease_conflict",
    "an unproven lifecycle attempt keeps its lease held",
  );

  const mutation = taskMutation(
    cellFor(sessionFor("exited"), "stopped"),
    { kind: "task-release", taskId: task.taskId, reason: "The holder session exited after settlement." },
    task,
    snapshotFor(),
    replacement,
  );
  assert.equal(mutation.type, "lease_released");
  assert.equal(mutation.releasedLease, heldLease);
});

test("terminal lease release follows the aggregate stop proof", () => {
  const runtimeSessionId = "runtime-terminal-proof",
    dispatchId = "dispatch-runtime-terminal-proof",
    source = "local" as const,
    orphanedLease = {
      ...lease,
      actor: {
        principal: { personId: "person-owner" },
        executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
      },
      phase: "orphaned" as const,
    },
    events = [
      lifecycleEvent("R", runtimeSessionId, {
        instanceId: "codex-test",
        source,
        dispatchId,
        taskId: task.taskId,
        executionId: lease.executionId,
      }),
    ],
    runtimeSession = {
      runtimeSessionId,
      taskBindings: [{ taskId: task.taskId, executionId: lease.executionId }],
    },
    terminalCell = {
      ...cell,
      projection: {
        readRuntimeSession: (id: string) => (id === runtimeSessionId ? runtimeSession : null),
        readDispatchLifecycle: dispatchLifecycleReadOf(() => events),
      },
    },
    terminalAction = {
      kind: "task-release" as const,
      taskId: task.taskId,
      terminalExecutionId: lease.executionId,
      terminalRuntimeSessionId: runtimeSessionId,
    },
    binding = authorized(owner("replacement-worker"));

  assert.throws(
    () => taskMutation(terminalCell, terminalAction, task, { ...snapshot(), lease: orphanedLease }, binding),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
    "an admitted but unstopped attempt keeps its lease",
  );

  events.push(lifecycleEvent("X", runtimeSessionId, { instanceId: "codex-test", source }));
  const mutation = taskMutation(terminalCell, terminalAction, task, { ...snapshot(), lease: orphanedLease }, binding);
  assert.equal(mutation.type, "lease_released", "accepted runtime_session_exited releases the matching lease");
  assert.equal(mutation.releasedLease, orphanedLease);
});
