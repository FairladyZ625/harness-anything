// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { domainStatuses, type DomainStatus } from "../../src/domain/lifecycle-status.ts";
import { statusWordRegister } from "../../src/domain/status-word-register.ts";
import { createTaskActionCatalog } from "../../src/domain/task-action-contract.ts";
import {
  taskBoardColumnIds,
  taskBoardColumnOf,
  taskBoardPlacement,
  taskBoardRankOf,
  taskCapabilities,
  taskCapabilityIds,
  taskCapabilityReasons,
  taskVisibility,
  type TaskBoardRowInput,
  type TaskCapabilityId,
} from "../../src/domain/task-board-projection.ts";
import type { TaskLifecycleSnapshot } from "../../src/domain/task-lifecycle-contract-internal-types.ts";

test("every board column is a coordination status the projection can actually produce", () => {
  // unknown is the only status without a column: an unresolved row belongs on no board.
  assert.deepEqual(taskBoardColumnOf("unknown"), null);
  const produced = new Set(domainStatuses.map((status) => taskBoardColumnOf(status)));
  assert.deepEqual([...produced].sort(), [...taskBoardColumnIds].sort());
});

test("column and rank are total over the status vocabulary", () => {
  const table = [...domainStatuses, "unknown" as const].map((status) => ({
    status,
    columnId: taskBoardColumnOf(status),
    rank: taskBoardRankOf(status),
  }));
  assert.deepEqual(table, [
    { status: "planned", columnId: "open", rank: 3 },
    { status: "active", columnId: "open", rank: 1 },
    { status: "blocked", columnId: "blocked", rank: 0 },
    { status: "in_review", columnId: "in_review", rank: 2 },
    { status: "done", columnId: "terminal", rank: 4 },
    { status: "cancelled", columnId: "terminal", rank: 5 },
    { status: "unknown", columnId: null, rank: 5 },
  ]);
});

test("a blocked relation moves an open task's column without changing its canonical status", () => {
  // The column follows workspaceTaskStatus, so blocking is reflected once, in the kernel.
  assert.deepEqual(taskBoardPlacement(row({ status: "planned", blockingState: "blocked" })), {
    columnId: "blocked",
    rank: 0,
  });
  assert.deepEqual(taskBoardPlacement(row({ status: "in_review", blockingState: "blocked" })), {
    columnId: "in_review",
    rank: 2,
  });
  assert.deepEqual(taskBoardPlacement(row({ snapshot: { ...emptySnapshot, task: null } })), {
    columnId: null,
    rank: 5,
  });
});

test("visibility is the package disposition and nothing else", () => {
  assert.deepEqual(taskVisibility(row({})), { archived: false });
  assert.deepEqual(taskVisibility(row({ packageDisposition: "archived" })), { archived: true });
  assert.deepEqual(taskVisibility(row({ packageDisposition: "tombstoned" })), { archived: true });
  // A cancelled task whose package is still active is not archived: those are two questions.
  assert.deepEqual(taskVisibility(row({ status: "cancelled" })), { archived: false });
});

test("capabilities are the same ids in the same order on every row", () => {
  for (const input of [row({}), row({ packageDisposition: "archived" }), row({ status: "done" })])
    assert.deepEqual(
      taskCapabilities(input).map(({ id }) => id),
      [...taskCapabilityIds],
    );
});

test("an archived or externally owned package affords nothing", () => {
  for (const input of [
    row({ packageDisposition: "archived", origin: "archival" }),
    row({ packageDisposition: "tombstoned", origin: "archival" }),
    row({ origin: "external" }),
  ])
    assert.deepEqual(
      taskCapabilities(input).map(({ available, reason }) => ({ available, reason })),
      taskCapabilityIds.map(() => ({ available: false, reason: "invalid_disposition" })),
    );
});

test("start is available exactly on an unblocked, unleased, planned native package", () => {
  assert.equal(reasonFor("start", row({})), null);
  assert.equal(reasonFor("start", row({ blockingState: "blocked" })), "blocked");
  assert.equal(reasonFor("start", row({ blockingState: "unknown" })), "unknown");
  assert.equal(reasonFor("start", row({ status: "active" })), "invalid_transition");
  assert.equal(reasonFor("start", row({ status: "done" })), "invalid_transition");
  assert.equal(reasonFor("start", leased({ status: "planned" })), "lease_conflict");
});

test("progress and submit require the task to be active and leased", () => {
  for (const id of ["progress", "submit"] as const) {
    assert.equal(reasonFor(id, row({ status: "planned" })), "invalid_transition");
    assert.equal(reasonFor(id, row({ status: "active" })), "lease_required");
    assert.equal(reasonFor(id, leased({ status: "active" })), null);
  }
});

test("review needs a released lease and a current submitted execution", () => {
  assert.equal(reasonFor("review", leased({ status: "in_review" })), "lease_conflict");
  assert.equal(reasonFor("review", row({ status: "in_review" })), "invalid_transition");
  assert.equal(reasonFor("review", submitted()), null);
});

test("complete is the kernel closeout readiness, not a status comparison", () => {
  assert.equal(reasonFor("complete", row({ status: "in_review" })), "completion_blocked");
  assert.equal(reasonFor("complete", row({ status: "in_review", closeoutReadiness: "ready" })), null);
  assert.equal(reasonFor("complete", leased({ status: "in_review", closeoutReadiness: "ready" })), "lease_conflict");
});

test("no reason is free text: every word is a rejection code or a registered status word", () => {
  // The reviewer's rejection condition for this projection. A reason the renderer cannot map back
  // to the kernel is prose, and prose is what dec_8DCD52E9 froze 67 renderer judgments to stop.
  const failureCodes = new Set(
    createTaskActionCatalog(
      (id) =>
        ({ id, criteria: [], input: { schema: "entity-action-input/v1", fields: [], exactlyOneOf: [] } }) as never,
      null as never,
    ).actions.flatMap((action) => action.criteria.map((criterion) => criterion.failureCode)),
  );
  const statusWords = new Set(statusWordRegister.map((registration) => registration.word));
  const unregistered = taskCapabilityReasons.filter((reason) => !failureCodes.has(reason) && !statusWords.has(reason));
  assert.deepEqual(unregistered, [], "every capability reason must come from an existing vocabulary");
  assert.equal(failureCodes.has("invalid_disposition"), true, "negative control: the code set is non-empty");
});

const emptySnapshot: TaskLifecycleSnapshot = {
  revision: 7,
  task: null,
  executions: [],
  reviews: [],
  consents: [],
  codeDocWitnesses: [],
  gateWitnesses: [],
  edgesTaken: [],
  lease: null,
};

function reasonFor(id: TaskCapabilityId, input: TaskBoardRowInput): string | null {
  return taskCapabilities(input).find((capability) => capability.id === id)!.reason;
}

function row(overrides: Partial<TaskBoardRowInput> & { readonly status?: DomainStatus }): TaskBoardRowInput {
  const { status = "planned", ...rest } = overrides;
  return {
    snapshot: { ...emptySnapshot, task: task(status) },
    blockingState: "clear",
    packageDisposition: "active",
    origin: "native",
    closeoutReadiness: "incomplete",
    ...rest,
  };
}

function leased(overrides: Partial<TaskBoardRowInput> & { readonly status?: DomainStatus }): TaskBoardRowInput {
  const base = row(overrides);
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      lease: {
        executionId: "execution-1",
        phase: "held",
        expiresAt: "2026-09-02T00:00:00.000Z",
        actor: { principal: { personId: "person-owner" }, executor: null },
      } as TaskLifecycleSnapshot["lease"],
    },
  };
}

function submitted(): TaskBoardRowInput {
  const base = row({ status: "in_review" });
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      executions: [
        {
          schema: "execution/v1",
          executionId: "execution-1",
          iteration: 0,
          state: "submitted",
          submission: { completionClaim: "done" },
          actor: { principal: { personId: "person-owner" }, executor: null },
        } as unknown as TaskLifecycleSnapshot["executions"][number],
      ],
    },
  };
}

function task(status: DomainStatus): TaskLifecycleSnapshot["task"] {
  return {
    schema: "task/v2",
    taskId: "task_board",
    title: "Board row",
    taskClass: "standard",
    status,
    graph: {},
    currentNode: "implementation",
    iteration: 0,
    createdBy: { principal: { personId: "person-owner" }, executor: null },
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
    packageDisposition: "active",
  } as unknown as TaskLifecycleSnapshot["task"];
}
