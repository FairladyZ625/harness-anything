// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { type ActorIdentity, type LeaseV1, type TaskLifecycleSnapshot, type TaskV1 } from "../../kernel/src/index.ts";
import { taskSurfaceWrite } from "../src/repo-cell-task-command-docs.ts";
import { taskMutation } from "../src/repo-cell-task-command.ts";

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
